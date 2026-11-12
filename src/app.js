// Servidor HTTP: site público, API de pedidos e painel do dono.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATALOGO, MAX_QUANTIDADE, PAGAMENTOS, RETIRADAS, SITUACOES, TAXA_ENTREGA, diaLocal, validarPedido,
} from './pedidos.js';
import { montarResumo, textoDoRelatorio } from './resumo.js';
import { configRelatorio, enviarRelatorio } from './agenda.js';
import { criarLimite, lerCookie } from './sessao.js';

const PUBLICO = fileURLToPath(new URL('../public/', import.meta.url));
const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};
const DIA_VALIDO = /^\d{4}-\d{2}-\d{2}$/;
const HORARIO_VALIDO = /^([01]\d|2[0-3]):[0-5]\d$/;

class ErroHttp extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.status = status;
  }
}

function json(res, status, corpo, cabecalhos = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cabecalhos });
  res.end(JSON.stringify(corpo));
}

async function lerCorpo(req, limite = 10_000) {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new ErroHttp(415, 'Envie JSON.');
  }
  let tamanho = 0;
  const partes = [];
  for await (const parte of req) {
    tamanho += parte.length;
    if (tamanho > limite) throw new ErroHttp(413, 'Pedido grande demais.');
    partes.push(parte);
  }
  try {
    return JSON.parse(Buffer.concat(partes).toString('utf8') || '{}');
  } catch {
    throw new ErroHttp(400, 'JSON inválido.');
  }
}

const ipDe = (req) => String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress;

export function criarApp({ banco, whatsapp, agenda, sessoes, agora = () => new Date(), producao = false, log = console }) {
  const ouvintes = new Set();
  const limitePedidos = criarLimite({ maximo: 8, janela: 10 * 60_000 });
  const limiteLogin = criarLimite({ maximo: 10, janela: 15 * 60_000 });

  function avisar(tipo, dados = {}) {
    const linha = `event: ${tipo}\ndata: ${JSON.stringify(dados)}\n\n`;
    for (const res of ouvintes) res.write(linha);
  }

  const logado = (req) => sessoes.valida(lerCookie(req, 'sessao'));
  const cookie = (valor, maxAge) =>
    `sessao=${valor}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${producao ? '; Secure' : ''}`;

  async function painelWhatsapp() {
    return {
      ...whatsapp.status(),
      destino: await banco.ler('whatsapp'),
      relatorio: await configRelatorio(banco),
      enviadoHoje: await banco.relatorioEnviado(diaLocal(agora())),
      pendencia: agenda?.pendencia() ?? null,
    };
  }

  async function servirArquivo(req, res, caminho) {
    let relativo = decodeURIComponent(caminho);
    if (relativo.endsWith('/')) relativo += 'index.html';
    if (relativo === '/painel') relativo = '/painel.html';
    const arquivo = normalize(join(PUBLICO, relativo));
    if (!arquivo.startsWith(PUBLICO.endsWith(sep) ? PUBLICO : PUBLICO + sep)) throw new ErroHttp(404, 'Não encontrado.');
    const info = await stat(arquivo).catch(() => null);
    if (!info?.isFile()) throw new ErroHttp(404, 'Não encontrado.');
    const tipo = TIPOS[extname(arquivo).toLowerCase()] ?? 'application/octet-stream';
    const imagem = tipo.startsWith('image/');
    res.writeHead(200, {
      'Content-Type': tipo,
      'Cache-Control': imagem ? 'public, max-age=604800' : 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    res.end(await readFile(arquivo));
  }

  const rotas = {
    'GET /saude': async (req, res) => json(res, 200, { ok: true }),

    'GET /api/catalogo': async (req, res) =>
      json(res, 200, { produtos: CATALOGO, taxaEntrega: TAXA_ENTREGA, maxQuantidade: MAX_QUANTIDADE, pagamentos: PAGAMENTOS, retiradas: RETIRADAS }),

    'POST /api/pedidos': async (req, res) => {
      if (!limitePedidos(ipDe(req))) throw new ErroHttp(429, 'Muitos pedidos seguidos. Tente de novo em alguns minutos.');
      const corpo = await lerCorpo(req);
      if (corpo?.site) return json(res, 201, { ok: true }); // campo-isca preenchido por robôs
      const { pedido, erros } = validarPedido(corpo);
      if (erros) return json(res, 400, { erro: erros.join(' '), erros });
      const momento = agora();
      const salvo = await banco.criarPedido(pedido, diaLocal(momento), momento);
      avisar('pedido', { id: salvo.id, dia: salvo.dia });
      json(res, 201, { ok: true, numero: salvo.numero, total: salvo.total });
    },

    'POST /api/painel/entrar': async (req, res) => {
      if (!sessoes.habilitado) throw new ErroHttp(503, 'Painel sem senha configurada (PAINEL_SENHA).');
      if (!limiteLogin(ipDe(req))) throw new ErroHttp(429, 'Muitas tentativas. Espere 15 minutos.');
      const { senha } = await lerCorpo(req);
      if (!sessoes.conferirSenha(senha)) throw new ErroHttp(401, 'Senha incorreta.');
      json(res, 200, { ok: true }, { 'Set-Cookie': cookie(sessoes.emitir(), sessoes.duracaoSegundos) });
    },

    'POST /api/painel/sair': async (req, res) => json(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) }),

    'GET /api/painel/sessao': async (req, res) => json(res, 200, { logado: logado(req), habilitado: sessoes.habilitado }),
  };

  const rotasDoPainel = {
    'GET /api/painel/pedidos': async (req, res, url) => {
      const dia = url.searchParams.get('dia') || diaLocal(agora());
      if (!DIA_VALIDO.test(dia)) throw new ErroHttp(400, 'Dia inválido.');
      const pedidos = await banco.listarPedidos(dia);
      json(res, 200, {
        dia,
        hoje: diaLocal(agora()),
        pedidos,
        resumo: montarResumo(pedidos),
        texto: textoDoRelatorio(pedidos, dia),
        relatorio: await banco.relatorioEnviado(dia),
        nomes: { pagamentos: PAGAMENTOS, retiradas: RETIRADAS, situacoes: SITUACOES },
      });
    },

    'POST /api/painel/situacao': async (req, res) => {
      const { id, situacao } = await lerCorpo(req);
      if (typeof id !== 'string' || !Object.hasOwn(SITUACOES, situacao ?? '')) throw new ErroHttp(400, 'Situação inválida.');
      const pedido = await banco.mudarSituacao(id, situacao);
      if (!pedido) throw new ErroHttp(404, 'Pedido não encontrado.');
      avisar('pedido', { id, dia: pedido.dia });
      json(res, 200, { ok: true });
    },

    'GET /api/painel/eventos': async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      ouvintes.add(res);
      const pulso = setInterval(() => res.write(': ok\n\n'), 25_000);
      req.on('close', () => {
        clearInterval(pulso);
        ouvintes.delete(res);
      });
    },

    'GET /api/painel/whatsapp': async (req, res) => json(res, 200, await painelWhatsapp()),

    'POST /api/painel/whatsapp/conectar': async (req, res) => {
      await whatsapp.conectar();
      json(res, 200, { ok: true });
    },

    'POST /api/painel/whatsapp/desconectar': async (req, res) => {
      await whatsapp.desconectar();
      json(res, 200, { ok: true });
    },

    'POST /api/painel/whatsapp/grupo': async (req, res) => {
      const { telefone } = await lerCorpo(req);
      const digitos = String(telefone ?? '').replace(/\D/g, '');
      if (digitos.length < 10 || digitos.length > 13) throw new ErroHttp(400, 'Informe o WhatsApp do dono com DDD.');
      const grupo = await whatsapp.criarGrupo(digitos).catch((e) => {
        throw new ErroHttp(400, e.message);
      });
      await banco.gravar('whatsapp', { grupoJid: grupo.jid, grupoNome: grupo.nome, numeroDono: digitos });
      await whatsapp
        .enviar(grupo.jid, 'Olá! Este grupo vai receber o relatório de pedidos do site todo dia. ✅')
        .catch(() => {});
      avisar('whatsapp', whatsapp.status());
      json(res, 200, { ok: true, grupo });
    },

    'POST /api/painel/relatorio': async (req, res) => {
      const { horario, ativo } = await lerCorpo(req);
      if (!HORARIO_VALIDO.test(horario ?? '') || typeof ativo !== 'boolean') throw new ErroHttp(400, 'Horário inválido.');
      await banco.gravar('relatorio', { horario, ativo });
      json(res, 200, { ok: true });
    },

    'POST /api/painel/relatorio/enviar': async (req, res) => {
      const { dia = diaLocal(agora()) } = await lerCorpo(req);
      if (!DIA_VALIDO.test(dia)) throw new ErroHttp(400, 'Dia inválido.');
      await enviarRelatorio({ banco, whatsapp, dia }).catch((e) => {
        throw new ErroHttp(400, e.message);
      });
      json(res, 200, { ok: true });
    },
  };

  async function tratar(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    const url = new URL(req.url, 'http://local');
    const chave = `${req.method} ${url.pathname}`;
    try {
      if (rotas[chave]) return await rotas[chave](req, res, url);
      if (rotasDoPainel[chave]) {
        if (!logado(req)) throw new ErroHttp(401, 'Entre no painel de novo.');
        return await rotasDoPainel[chave](req, res, url);
      }
      if (url.pathname.startsWith('/api/')) throw new ErroHttp(404, 'Não encontrado.');
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new ErroHttp(405, 'Método não permitido.');
      await servirArquivo(req, res, url.pathname);
    } catch (erro) {
      const status = erro instanceof ErroHttp ? erro.status : 500;
      if (status === 500) log.error?.(`${chave}:`, erro);
      if (res.headersSent) return res.end();
      json(res, status, { erro: status === 500 ? 'Erro interno. Tente de novo.' : erro.message });
    }
  }

  const servidor = createServer(tratar);
  return { servidor, avisar };
}
