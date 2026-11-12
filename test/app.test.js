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
    if (!this.conectado) throw new Error('WhatsApp do robô não está conectado.');
    enviados.push({ jid, texto });
  },
  async criarGrupo(tel) {
    return { jid: `grupo-${tel}@g.us`, nome: 'Pedidos TH das Réguas' };
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

const pedido = (extra = {}) => ({
  nome: 'Ana Lima', telefone: '98991112222', produto: 'touca-leon', quantidade: 1, pagamento: 'pix', retirada: 'loja', ...extra,
});

test('site e painel são servidos; arquivos fora da pasta pública não', async () => {
  assert.equal((await chamar('/')).status, 200);
  assert.equal((await chamar('/painel')).status, 200);
  assert.equal((await chamar('/img/touca-detalhe.jpg')).headers.get('content-type'), 'image/jpeg');
  assert.equal((await chamar('/..%2Fsrc%2Fapp.js')).status, 404);
  assert.equal((await chamar('/%2e%2e/package.json')).status, 404);
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
  const grande = await chamar('/api/pedidos', { corpo: pedido({ observacao: 'x'.repeat(20_000) }), ip: '2.2.2.3' });
  assert.equal(grande.status, 413);
});

test('robô que preenche o campo-isca não grava pedido', async () => {
  const r = await chamar('/api/pedidos', { corpo: pedido({ site: 'http://spam' }), ip: '3.3.3.3' });
  assert.equal(r.status, 201);
  assert.equal((await banco.listarPedidos('2026-11-12')).length, 2);
});

test('limite de pedidos por IP', async () => {
  let ultimo;
  for (let i = 0; i < 9; i++) ultimo = await chamar('/api/pedidos', { corpo: { nome: 'x' }, ip: '9.9.9.9' });
  assert.equal(ultimo.status, 429);
});

test('painel exige login', async () => {
  assert.equal((await chamar('/api/painel/pedidos')).status, 401);
  assert.equal((await chamar('/api/painel/eventos')).status, 401);
  const errado = await chamar('/api/painel/entrar', { corpo: { senha: 'errada' }, ip: '4.4.4.4' });
  assert.equal(errado.status, 401);
  const forjado = await chamar('/api/painel/pedidos', { comCookie: false, metodo: 'GET' });
  assert.equal(forjado.status, 401);

  const certo = await chamar('/api/painel/entrar', { corpo: { senha: 'senha-teste' }, ip: '4.4.4.4' });
  assert.equal(certo.status, 200);
  const setCookie = certo.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  cookie = setCookie.split(';')[0];
  assert.equal((await (await chamar('/api/painel/sessao')).json()).logado, true);
});

test('painel mostra pedidos e resumo do dia', async () => {
  const d = await (await chamar('/api/painel/pedidos')).json();
  assert.equal(d.dia, '2026-11-12');
  assert.equal(d.pedidos.length, 2);
  assert.equal(d.resumo.clientes, 2);
  assert.equal(d.resumo.itens, 3);
  assert.equal(d.resumo.porRetirada.entrega, 1);
  assert.match(d.texto, /Bruno — 1x Caixa de touca Leon Barber — Dinheiro \(troco p\/ R\$ 200,00\) — Entrega/);
  assert.equal((await chamar('/api/painel/pedidos?dia=ontem')).status, 400);
});

test('dono muda a situação; cancelado sai do resumo', async () => {
  const { pedidos } = await (await chamar('/api/painel/pedidos')).json();
  const bruno = pedidos.find((p) => p.nome === 'Bruno');
  assert.equal((await chamar('/api/painel/situacao', { corpo: { id: bruno.id, situacao: 'voando' } })).status, 400);
  assert.equal((await chamar('/api/painel/situacao', { corpo: { id: 'nao-existe', situacao: 'entregue' } })).status, 404);
  assert.equal((await chamar('/api/painel/situacao', { corpo: { id: bruno.id, situacao: 'cancelado' } })).status, 200);
  const d = await (await chamar('/api/painel/pedidos')).json();
  assert.equal(d.resumo.pedidos, 1);
  assert.equal(d.resumo.cancelados, 1);
  await chamar('/api/painel/situacao', { corpo: { id: bruno.id, situacao: 'novo' } });
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
  assert.match(enviados[1].texto, /2 cliente\(s\)/);

  await agenda.verificar(new Date('2026-11-12T22:00:00Z'));
  assert.equal(enviados.length, 2, 'não repete no mesmo dia');

  const d = await (await chamar('/api/painel/pedidos')).json();
  assert.ok(d.relatorio.enviadoEm);
});

test('WhatsApp desconectado no horário fica pendente e envia quando volta', async () => {
  whatsapp.conectado = false;
  const dia13 = new Date('2026-11-13T21:30:00Z');
  await agenda.verificar(dia13);
  assert.match(agenda.pendencia(), /desconectado/);
  whatsapp.conectado = true;
  await agenda.verificar(new Date('2026-11-13T23:00:00Z'));
  assert.equal(agenda.pendencia(), null);
  assert.match(enviados.at(-1).texto, /Nenhum pedido hoje/);
});

test('configurar horário do relatório', async () => {
  assert.equal((await chamar('/api/painel/relatorio', { corpo: { horario: '25:00', ativo: true } })).status, 400);
  assert.equal((await chamar('/api/painel/relatorio', { corpo: { horario: '19:30', ativo: false } })).status, 200);
  const w = await (await chamar('/api/painel/whatsapp')).json();
  assert.deepEqual(w.relatorio, { horario: '19:30', ativo: false });
});

test('sair apaga o cookie', async () => {
  const r = await chamar('/api/painel/sair', { corpo: {} });
  assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
});
