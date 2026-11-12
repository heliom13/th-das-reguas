// Servidor HTTP: site público, API de pedidos e painel do dono.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATALOGO_PADRAO, MAX_QUANTIDADE, PAGAMENTOS, RETIRADAS, SITUACOES, diaLocal, validarCatalogo, validarPedido,
} from './pedidos.js';
import { montarResumo, resumoPorDia, textoDoAviso, textoDoRelatorio } from './resumo.js';
import { configRelatorio, enviarRelatorio } from './agenda.js';
import { csvDosPedidos } from './exportar.js';
import { criarLimite, lerCookie } from './sessao.js';

const PUBLICO = fileURLToPath(new URL('../public/', import.meta.url));
const RAIZ = PUBLICO.endsWith(sep) ? PUBLICO : PUBLICO + sep;
const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};
const DIA_VALIDO = /^\d{4}-\d{2}-\d{2}$/;
const HORARIO_VALIDO = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_DIAS_PERIODO = 366;
const NOMES = { pagamentos: PAGAMENTOS, retiradas: RETIRADAS, situacoes: SITUACOES };

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
    if (tamanho > limite) throw new ErroHttp(413, 'Dados grandes demais.');
    partes.push(parte);
  }
  try {
    const corpo = JSON.parse(Buffer.concat(partes).toString('utf8') || '{}');
    if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) throw new Error();
    return corpo;
  } catch {
    throw new ErroHttp(400, 'JSON inválido.');
  }
}

// IP real do cliente atrás do Cloudflare/Render.
const ipDe = (req) =>
  req.headers['cf-connecting-ip'] ||
  req.headers['true-client-ip'] ||
  String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() ||
  req.socket.remoteAddress;

export async function lerCatalogo(banco) {
  return (await banco.ler('catalogo')) ?? CATALOGO_PADRAO;
}

function periodo(url) {
  const de = url.searchParams.get('de');
  const ate = url.searchParams.get('ate');
  if (!DIA_VALIDO.test(de ?? '') || !DIA_VALIDO.test(ate ?? '') || de > ate) throw new ErroHttp(400, 'Período inválido.');
  const dias = (Date.parse(ate) - Date.parse(de)) / 86_400_000;
  if (!(dias >= 0 && dias < MAX_DIAS_PERIODO)) throw new ErroHttp(400, `Escolha um período de até ${MAX_DIAS_PERIODO} dias.`);
  return { de, ate };
}

export function criarApp({ banco, whatsapp, agenda, sessoes, agora = () => new Date(), producao = false, log = console }) {
  const ouvintes = new Set();
  const limitePedidos = criarLimite({ maximo: 20, janela: 10 * 60_000 });
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

  // Aviso no grupo a cada pedido (opcional). Nunca atrasa nem derruba o pedido do cliente.
  async function avisarNoGrupo(pedido) {
    const { avisarPedido } = await configRelatorio(banco);
    if (!avisarPedido || whatsapp.status().estado !== 'conectado') return;
    const destino = await banco.ler('whatsapp');
    if (destino?.grupoJid) await whatsapp.enviar(destino.grupoJid, textoDoAviso(pedido));
  }

  async function servirArquivo(req, res, caminho) {
    let relativo;
    try {
      relativo = decodeURIComponent(caminho);
    } catch {
      throw new ErroHttp(400, 'Endereço inválido.');
    }
    if (relativo === '/painel' || relativo === '/painel/') relativo = '/painel.html';
    if (relativo.endsWith('/')) relativo += 'index.html';
    const arquivo = normalize(join(PUBLICO, relativo));
    if (!arquivo.startsWith(RAIZ)) throw new ErroHttp(404, 'Não encontrado.');
    const info = await stat(arquivo).catch(() => null);
    if (!info?.isFile()) throw new ErroHttp(404, 'Não encontrado.');
    const tipo = TIPOS[extname(arquivo).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': tipo,
      'Content-Length': info.size,
      'Cache-Control': tipo.startsWith('image/') ? 'public, max-age=604800' : 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    res.end(await readFile(arquivo));
  }

  const rotas = {
    'GET /saude': async (req, res) => json(res, 200, { ok: true }),

    'GET /api/catalogo': async (req, res) => {
      const { produtos, taxaEntrega } = await lerCatalogo(banco);
      json(res, 200, {
        produtos: produtos.filter((p) => p.ativo).map(({ id, nome, detalhe, preco, precoAntigo }) => ({ id, nome, detalhe, preco, precoAntigo })),
        taxaEntrega,
        maxQuantidade: MAX_QUANTIDADE,
      });
    },

    'POST /api/pedidos': async (req, res) => {
      if (!limitePedidos(ipDe(req))) throw new ErroHttp(429, 'Muitos pedidos seguidos. Tente de novo em alguns minutos.');
      const corpo = await lerCorpo(req);
      if (corpo.site) return json(res, 201, { ok: true, numero: 0, total: 0 }); // campo-isca preenchido por robôs
      const { pedido, erros } = validarPedido(corpo, await lerCatalogo(banco));
      if (erros) return json(res, 400, { erro: erros.join(' '), erros });
      const momento = agora();
      const salvo = await banco.criarPedido(pedido, diaLocal(momento), momento);
      avisar('pedido', { id: salvo.id, dia: salvo.dia });
      avisarNoGrupo(salvo).catch((e) => log.error?.('Aviso de pedido no grupo:', e.message));
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
        nomes: NOMES,
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

    'POST /api/painel/apagar': async (req, res) => {
      const { id } = await lerCorpo(req);
      if (typeof id !== 'string') throw new ErroHttp(400, 'Pedido inválido.');
      const pedido = await banco.apagarCancelado(id);
      if (!pedido) throw new ErroHttp(400, 'Só dá para apagar pedido cancelado.');
      avisar('pedido', { id, dia: pedido.dia });
      json(res, 200, { ok: true });
    },

    'GET /api/painel/periodo': async (req, res, url) => {
      const { de, ate } = periodo(url);
      const pedidos = await banco.listarPedidosPeriodo(de, ate);
      json(res, 200, { de, ate, resumo: montarResumo(pedidos), porDia: resumoPorDia(pedidos, de, ate), nomes: NOMES });
    },

    'GET /api/painel/exportar': async (req, res, url) => {
      const { de, ate } = periodo(url);
      const csv = csvDosPedidos(await banco.listarPedidosPeriodo(de, ate));
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="pedidos-${de}-a-${ate}.csv"`,
        'Cache-Control': 'no-store',
      });
      res.end(csv);
    },

    'GET /api/painel/catalogo': async (req, res) => json(res, 200, await lerCatalogo(banco)),

    'POST /api/painel/catalogo': async (req, res) => {
      const { catalogo, erros } = validarCatalogo(await lerCorpo(req, 50_000));
      if (erros) return json(res, 400, { erro: erros.join(' '), erros });
      await banco.gravar('catalogo', catalogo);
      json(res, 200, { ok: true, catalogo });
    },

    'GET /api/painel/eventos': async (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
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
      await whatsapp.conectar().catch((e) => {
        throw new ErroHttp(409, e.message);
      });
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
      await banco.gravar('whatsapp', {
        grupoJid: grupo.jid, grupoNome: grupo.nome, numeroDono: digitos, donoNoGrupo: grupo.donoNoGrupo, convite: grupo.convite,
      });
      await whatsapp
        .enviar(grupo.jid, 'Olá! Este grupo vai receber o relatório de pedidos do site todo dia. ✅')
        .catch(() => {});
      avisar('whatsapp', whatsapp.status());
      json(res, 200, { ok: true, grupo });
    },

    'POST /api/painel/whatsapp/teste': async (req, res) => {
      const destino = await banco.ler('whatsapp');
      if (!destino?.grupoJid) throw new ErroHttp(400, 'Crie o grupo do relatório primeiro.');
      await whatsapp.enviar(destino.grupoJid, '✅ Teste do robô de pedidos: tudo funcionando.').catch((e) => {
        throw new ErroHttp(400, e.message);
      });
      json(res, 200, { ok: true });
    },

    'POST /api/painel/relatorio': async (req, res) => {
      const { horario, ativo, avisarPedido = false } = await lerCorpo(req);
      if (!HORARIO_VALIDO.test(horario ?? '') || typeof ativo !== 'boolean' || typeof avisarPedido !== 'boolean') {
        throw new ErroHttp(400, 'Horário inválido.');
      }
      await banco.gravar('relatorio', { horario, ativo, avisarPedido });
      avisar('whatsapp', whatsapp.status());
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
    let url;
    try {
      url = new URL(req.url, 'http://local');
    } catch {
      return json(res, 400, { erro: 'Endereço inválido.' });
    }
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
  servidor.requestTimeout = 30_000;
  return { servidor, avisar };
}
