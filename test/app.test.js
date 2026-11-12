import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { criarApp } from '../src/app.js';
import { criarAgenda } from '../src/agenda.js';
import { criarBancoMemoria } from '../src/banco.js';
import { criarSessoes } from '../src/sessao.js';

// 12/11/2026 17:59 em São Luís (UTC-3)
let relogio = new Date('2026-11-12T20:59:00Z');
const enviados = [];
const whatsapp = {
  conectado: true,
  status() {
    return { estado: this.conectado ? 'conectado' : 'desligado', qr: null, numero: '5598900000000', erro: null };
  },
  async enviar(jid, texto) {
    if (!this.conectado) throw new Error('O WhatsApp do robô não está conectado.');
    enviados.push({ jid, texto });
  },
  async criarGrupo(tel) {
    return { jid: `grupo-${tel}@g.us`, nome: 'Pedidos TH das Réguas', donoNoGrupo: true, convite: null };
  },
  async conectar() {},
  async desconectar() {},
};
const banco = criarBancoMemoria();
const agenda = criarAgenda({ banco, whatsapp, log: {} });
const sessoes = criarSessoes({ senha: 'senha-teste' });
const { servidor } = criarApp({ banco, whatsapp, agenda, sessoes, agora: () => relogio, log: {} });
let base;
let cookie = '';

before(async () => {
  await new Promise((ok) => servidor.listen(0, ok));
  base = `http://127.0.0.1:${servidor.address().port}`;
});
after(() => servidor.close());

const chamar = (caminho, { corpo, metodo, comCookie = true, ip } = {}) =>
  fetch(base + caminho, {
    method: metodo ?? (corpo ? 'POST' : 'GET'),
    headers: {
      ...(corpo ? { 'Content-Type': 'application/json' } : {}),
      ...(comCookie && cookie ? { Cookie: cookie } : {}),
      ...(ip ? { 'X-Forwarded-For': ip } : {}),
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
const dados = async (caminho) => (await chamar(caminho)).json();
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

const pedido = (extra = {}) => ({
  nome: 'Ana Lima', telefone: '98991112222', produto: 'touca-leon', quantidade: 1, pagamento: 'pix', retirada: 'loja', ...extra,
});

test('site e painel são servidos; arquivos fora da pasta pública não', async () => {
  assert.equal((await chamar('/')).status, 200);
  assert.equal((await chamar('/painel')).status, 200);
  assert.equal((await chamar('/painel/')).status, 200);
  assert.equal((await chamar('/img/touca-detalhe.jpg')).headers.get('content-type'), 'image/jpeg');
  assert.equal((await chamar('/..%2Fsrc%2Fapp.js')).status, 404);
  assert.equal((await chamar('/%2e%2e/package.json')).status, 404);
  assert.equal((await chamar('/%E0%A4%A')).status, 400);
  assert.equal((await chamar('/', { metodo: 'DELETE' })).status, 405);
});

test('catálogo público mostra só produtos ativos', async () => {
  const c = await dados('/api/catalogo');
  assert.equal(c.produtos.length, 1);
  assert.equal(c.produtos[0].id, 'touca-leon');
  assert.equal(c.taxaEntrega, 10);
  assert.equal(c.produtos[0].ativo, undefined);
});

test('cliente faz pedido e recebe número e total calculado no servidor', async () => {
  const r = await chamar('/api/pedidos', { corpo: pedido({ quantidade: 2, total: 1 }), ip: '1.1.1.1' });
  assert.equal(r.status, 201);
  assert.deepEqual(await r.json(), { ok: true, numero: 1, total: 270 });

  const r2 = await chamar('/api/pedidos', {
    corpo: pedido({ nome: 'Bruno', telefone: '98993334444', pagamento: 'dinheiro', troco: '200', retirada: 'entrega', endereco: 'Rua das Flores, 20' }),
    ip: '1.1.1.2',
  });
  assert.deepEqual(await r2.json(), { ok: true, numero: 2, total: 145 });
});

test('pedido inválido, sem JSON ou grande demais é recusado', async () => {
  const r = await chamar('/api/pedidos', { corpo: pedido({ retirada: 'entrega' }), ip: '2.2.2.2' });
  assert.equal(r.status, 400);
  assert.match((await r.json()).erro, /endereço/);
  const semJson = await fetch(base + '/api/pedidos', { method: 'POST', body: 'nome=x' });
  assert.equal(semJson.status, 415);
  const lista = await fetch(base + '/api/pedidos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[1]' });
  assert.equal(lista.status, 400);
  const grande = await chamar('/api/pedidos', { corpo: pedido({ observacao: 'x'.repeat(20_000) }), ip: '2.2.2.3' });
  assert.equal(grande.status, 413);
});

test('robô que preenche o campo-isca não grava pedido', async () => {
  const r = await chamar('/api/pedidos', { corpo: pedido({ site: 'http://spam' }), ip: '3.3.3.3' });
  assert.equal(r.status, 201);
  assert.equal((await banco.listarPedidos('2026-11-12')).length, 2);
});

test('limite de pedidos por IP (usa o IP do Cloudflare quando existe)', async () => {
  let ultimo;
  for (let i = 0; i < 21; i++) ultimo = await chamar('/api/pedidos', { corpo: { nome: 'x' }, ip: '9.9.9.9' });
  assert.equal(ultimo.status, 429);
  const outro = await fetch(base + '/api/pedidos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '9.9.9.9', 'CF-Connecting-IP': '8.8.8.8' },
    body: JSON.stringify({ nome: 'x' }),
  });
  assert.equal(outro.status, 400);
});

test('painel exige login', async () => {
  assert.equal((await chamar('/api/painel/pedidos')).status, 401);
  assert.equal((await chamar('/api/painel/eventos')).status, 401);
  assert.equal((await chamar('/api/painel/exportar?de=2026-11-01&ate=2026-11-30')).status, 401);
  assert.equal((await chamar('/api/painel/catalogo', { corpo: { produtos: [] } })).status, 401);
  const errado = await chamar('/api/painel/entrar', { corpo: { senha: 'errada' }, ip: '4.4.4.4' });
  assert.equal(errado.status, 401);
  const forjado = await fetch(base + '/api/painel/pedidos', { headers: { Cookie: 'sessao=9999999999999.abc' } });
  assert.equal(forjado.status, 401);

  const certo = await chamar('/api/painel/entrar', { corpo: { senha: 'senha-teste' }, ip: '4.4.4.4' });
  assert.equal(certo.status, 200);
  const setCookie = certo.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  cookie = setCookie.split(';')[0];
  assert.equal((await dados('/api/painel/sessao')).logado, true);
});

test('painel mostra pedidos e resumo do dia', async () => {
  const d = await dados('/api/painel/pedidos');
  assert.equal(d.dia, '2026-11-12');
  assert.equal(d.pedidos.length, 2);
  assert.equal(d.resumo.clientes, 2);
  assert.equal(d.resumo.itens, 3);
  assert.equal(d.resumo.porRetirada.entrega, 1);
  assert.match(d.texto, /Bruno — 1x Caixa de touca Leon Barber — Dinheiro \(troco p\/ R\$ 200,00\) — Entrega/);
  assert.equal((await chamar('/api/painel/pedidos?dia=ontem')).status, 400);
});

test('dono muda a situação; cancelado sai do resumo e só cancelado pode ser apagado', async () => {
  const { pedidos } = await dados('/api/painel/pedidos');
  const bruno = pedidos.find((p) => p.nome === 'Bruno');
  assert.equal((await chamar('/api/painel/situacao', { corpo: { id: bruno.id, situacao: 'voando' } })).status, 400);
  assert.equal((await chamar('/api/painel/situacao', { corpo: { id: 'nao-existe', situacao: 'entregue' } })).status, 404);
  assert.equal((await chamar('/api/painel/apagar', { corpo: { id: bruno.id } })).status, 400);
  assert.equal((await chamar('/api/painel/situacao', { corpo: { id: bruno.id, situacao: 'cancelado' } })).status, 200);
  const d = await dados('/api/painel/pedidos');
  assert.equal(d.resumo.pedidos, 1);
  assert.equal(d.resumo.cancelados, 1);
  await chamar('/api/painel/situacao', { corpo: { id: bruno.id, situacao: 'novo' } });

  const teste = await (await chamar('/api/pedidos', { corpo: pedido({ nome: 'TESTE' }), ip: '7.7.7.7' })).json();
  const t = (await dados('/api/painel/pedidos')).pedidos.find((p) => p.numero === teste.numero);
  await chamar('/api/painel/situacao', { corpo: { id: t.id, situacao: 'cancelado' } });
  assert.equal((await chamar('/api/painel/apagar', { corpo: { id: t.id } })).status, 200);
  assert.equal((await dados('/api/painel/pedidos')).pedidos.length, 2);
});

test('dono edita produtos e preço; o site e os pedidos novos seguem o catálogo', async () => {
  const atual = await dados('/api/painel/catalogo');
  assert.equal(atual.produtos[0].id, 'touca-leon');
  const ruim = await chamar('/api/painel/catalogo', { corpo: { produtos: [{ nome: 'Touca', preco: 0 }], taxaEntrega: 10 } });
  assert.equal(ruim.status, 400);

  const novo = {
    produtos: [
      { ...atual.produtos[0], preco: 130, precoAntigo: null },
      { nome: 'Touca tamanho M', detalhe: 'Para cabeças maiores', preco: '139,90', ativo: true },
      { nome: 'Kit fora de linha', preco: 50, ativo: false },
    ],
    taxaEntrega: 8,
  };
  const r = await chamar('/api/painel/catalogo', { corpo: novo });
  assert.equal(r.status, 200);
  const publico = await dados('/api/catalogo');
  assert.deepEqual(publico.produtos.map((p) => p.nome), ['Caixa de touca Leon Barber', 'Touca tamanho M']);
  assert.equal(publico.taxaEntrega, 8);

  const idM = publico.produtos[1].id;
  const pedidoM = await (await chamar('/api/pedidos', {
    corpo: pedido({ nome: 'Carla', telefone: '98977776666', produto: idM, quantidade: 2, retirada: 'entrega', endereco: 'Rua D, 4' }),
    ip: '5.5.5.5',
  })).json();
  assert.equal(pedidoM.total, 287.8);
  const inativo = (await (await chamar('/api/painel/catalogo')).json()).produtos[2].id;
  const recusado = await chamar('/api/pedidos', { corpo: pedido({ produto: inativo }), ip: '5.5.5.6' });
  assert.equal(recusado.status, 400);

  const d = await dados('/api/painel/pedidos');
  assert.equal(d.resumo.porProduto['Touca tamanho M'], 2);
  assert.equal(d.pedidos.find((p) => p.nome === 'Ana Lima' && p.quantidade === 2).total, 270, 'pedido antigo mantém o preço da época');
});

test('relatório por período e planilha', async () => {
  relogio = new Date('2026-11-14T15:00:00Z');
  await chamar('/api/pedidos', { corpo: pedido({ nome: 'Dia 14', telefone: '98955554444', quantidade: 3 }), ip: '6.6.6.6' });
  relogio = new Date('2026-11-12T20:59:00Z');

  const p = await dados('/api/painel/periodo?de=2026-11-12&ate=2026-11-14');
  assert.equal(p.porDia.length, 3);
  assert.deepEqual(p.porDia.map((d) => d.itens), [5, 0, 3]);
  assert.equal(p.resumo.itens, 8);
  assert.equal(p.resumo.clientes, 4);

  assert.equal((await chamar('/api/painel/periodo?de=2026-11-14&ate=2026-11-12')).status, 400);
  assert.equal((await chamar('/api/painel/periodo?de=2025-01-01&ate=2026-11-12')).status, 400);

  const csv = await chamar('/api/painel/exportar?de=2026-11-12&ate=2026-11-14');
  assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.match(csv.headers.get('content-disposition'), /pedidos-2026-11-12-a-2026-11-14\.csv/);
  const texto = await csv.text();
  assert.equal(texto.trim().split('\r\n').length, 1 + 4);
  assert.match(texto, /"14\/11\/2026";"1";"12:00";"Dia 14"/);
});

test('relatório automático: sem grupo não envia; depois envia uma vez só no horário', async () => {
  await agenda.verificar(relogio); // 17:59: antes do horário
  assert.equal(agenda.pendencia(), null);

  relogio = new Date('2026-11-12T21:00:00Z'); // 18:00
  await agenda.verificar(relogio);
  assert.match(agenda.pendencia(), /Crie o grupo/);
  assert.equal(enviados.length, 0);

  const g = await chamar('/api/painel/whatsapp/grupo', { corpo: { telefone: '(98) 99115-8516' } });
  assert.equal(g.status, 200);
  assert.equal(enviados.length, 1); // mensagem de boas-vindas

  await agenda.verificar(relogio);
  assert.equal(enviados.length, 2);
  assert.equal(enviados[1].jid, 'grupo-98991158516@g.us');
  assert.match(enviados[1].texto, /Pedidos do dia 12\/11\/2026/);
  assert.match(enviados[1].texto, /3 cliente\(s\)/);

  await agenda.verificar(new Date('2026-11-12T22:00:00Z'));
  assert.equal(enviados.length, 2, 'não repete no mesmo dia');
  assert.ok((await dados('/api/painel/pedidos')).relatorio.enviadoEm);
});

test('WhatsApp desconectado no horário fica pendente e envia quando volta', async () => {
  whatsapp.conectado = false;
  await agenda.verificar(new Date('2026-11-13T21:30:00Z'));
  assert.match(agenda.pendencia(), /desconectado/);
  whatsapp.conectado = true;
  await agenda.verificar(new Date('2026-11-13T23:00:00Z'));
  assert.equal(agenda.pendencia(), null);
  assert.match(enviados.at(-1).texto, /Nenhum pedido neste dia/);
});

test('mensagem de teste e aviso a cada pedido (opcional)', async () => {
  assert.equal((await chamar('/api/painel/whatsapp/teste', { corpo: {} })).status, 200);
  assert.match(enviados.at(-1).texto, /Teste do robô/);

  const antes = enviados.length;
  await chamar('/api/pedidos', { corpo: pedido({ nome: 'Sem aviso', telefone: '98911110000' }), ip: '7.7.7.8' });
  await esperar(30);
  assert.equal(enviados.length, antes, 'desligado por padrão');

  assert.equal((await chamar('/api/painel/relatorio', { corpo: { horario: '18:00', ativo: true, avisarPedido: true } })).status, 200);
  await chamar('/api/pedidos', { corpo: pedido({ nome: 'Com aviso', telefone: '98911110001' }), ip: '7.7.7.9' });
  await esperar(30);
  assert.match(enviados.at(-1).texto, /🆕 \*Pedido #\d+\* — Com aviso/);

  whatsapp.conectado = false;
  const r = await chamar('/api/pedidos', { corpo: pedido({ nome: 'Robô fora', telefone: '98911110002' }), ip: '7.7.7.10' });
  assert.equal(r.status, 201, 'pedido do cliente não depende do WhatsApp');
  whatsapp.conectado = true;
});

test('configurar horário do relatório', async () => {
  assert.equal((await chamar('/api/painel/relatorio', { corpo: { horario: '25:00', ativo: true } })).status, 400);
  assert.equal((await chamar('/api/painel/relatorio', { corpo: { horario: '19:30', ativo: false } })).status, 200);
  const w = await dados('/api/painel/whatsapp');
  assert.deepEqual(w.relatorio, { horario: '19:30', ativo: false, avisarPedido: false });
});

test('sair apaga o cookie', async () => {
  const r = await chamar('/api/painel/sair', { corpo: {} });
  assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
});
