import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { criarApp } from '../src/app.js';
import { criarBancoMemoria } from '../src/banco.js';
import { criarSessoes } from '../src/sessao.js';
import { assinaturaValida, criarMercadoPago, situacaoDoPagamento } from '../src/mercadopago.js';

// Mercado Pago simulado: guarda as cobranças criadas e responde como a API v1.
function mercadoPagoFalso() {
  const pagamentos = new Map();
  const chamadas = [];
  let proximo = 1000;
  let falhar = false;
  async function fetchImpl(url, { method, headers, body }) {
    chamadas.push({ url, method, headers, body: body ? JSON.parse(body) : null });
    const responder = (status, dados) => ({ ok: status < 400, status, json: async () => dados });
    if (falhar) return responder(500, { message: 'internal_error' });
    if (method === 'POST' && url.endsWith('/v1/payments')) {
      const b = JSON.parse(body);
      const id = String(proximo++);
      const p = {
        id: Number(id), status: 'pending', transaction_amount: b.transaction_amount, external_reference: b.external_reference,
        date_of_expiration: b.date_of_expiration,
        point_of_interaction: { transaction_data: { qr_code: `00020126PIX${id}`, qr_code_base64: 'iVBORw0KGgo=' } },
      };
      pagamentos.set(id, p);
      return responder(201, p);
    }
    const achado = url.match(/\/v1\/payments\/(\d+)$/);
    if (method === 'GET' && achado) {
      const p = pagamentos.get(achado[1]);
      return p ? responder(200, p) : responder(404, { message: 'not found' });
    }
    return responder(404, { message: 'rota desconhecida' });
  }
  return {
    fetchImpl,
    chamadas,
    pagamentos,
    falhar: (v) => { falhar = v; },
    mudar: (id, mudancas) => Object.assign(pagamentos.get(String(id)), mudancas),
  };
}

const SEGREDO = 'segredo-do-webhook';
const mp = mercadoPagoFalso();
let relogio = new Date('2026-11-17T15:00:00Z');
const enviados = [];
const whatsapp = {
  status: () => ({ estado: 'conectado' }),
  async enviar(jid, texto) { enviados.push({ jid, texto }); },
};
const banco = criarBancoMemoria();
const pagamentos = criarMercadoPago({
  token: 'TEST-token', segredoWebhook: SEGREDO, urlNotificacao: 'https://loja.test/webhooks/mercadopago',
  fetchImpl: mp.fetchImpl, agora: () => relogio,
});
const { servidor, conferirPixPendentes } = criarApp({
  banco, whatsapp, agenda: null, sessoes: criarSessoes({ senha: 'x' }), pagamentos, agora: () => relogio, log: {},
});
let base;

before(async () => {
  await new Promise((ok) => servidor.listen(0, ok));
  base = `http://127.0.0.1:${servidor.address().port}`;
  // Avisos no grupo ligados, como o dono usa.
  await banco.gravar('relatorio', { avisarPedido: true });
  await banco.gravar('whatsapp', { grupoJid: 'grupo@g.us' });
});
after(() => servidor.close());
beforeEach(() => { enviados.length = 0; mp.falhar(false); });

const post = (caminho, corpo, cabecalhos = {}) =>
  fetch(base + caminho, { method: 'POST', headers: { 'Content-Type': 'application/json', ...cabecalhos }, body: JSON.stringify(corpo) });
const pedidoPix = (extra = {}) => ({
  nome: 'Ana Lima', telefone: '98991112222', produto: 'touca-leon', quantidade: 2,
  pagamento: 'pix', retirada: 'entrega', endereco: 'Rua A, 10, Centro', email: 'ana@email.com', ...extra,
});
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function assinar(dataId, requestId = 'req-1', ts = '1700000000') {
  const v1 = createHmac('sha256', SEGREDO).update(`id:${dataId};request-id:${requestId};ts:${ts};`).digest('hex');
  return { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': requestId };
}
async function avisar(id, cabecalhos = assinar(id)) {
  return post(`/webhooks/mercadopago?data.id=${id}&type=payment`, { action: 'payment.updated', data: { id } }, cabecalhos);
}

test('situação do Mercado Pago vira situação do pedido', () => {
  assert.equal(situacaoDoPagamento('approved'), 'pago');
  assert.equal(situacaoDoPagamento('pending'), 'aguardando');
  assert.equal(situacaoDoPagamento('in_process'), 'aguardando');
  assert.equal(situacaoDoPagamento('cancelled'), 'expirado');
  assert.equal(situacaoDoPagamento('refunded'), 'estornado');
});

test('assinatura do aviso: aceita a correta e recusa adulterada, sem segredo ou sem cabeçalho', () => {
  const h = assinar('123');
  const base = { segredo: SEGREDO, xSignature: h['x-signature'], xRequestId: h['x-request-id'], dataId: '123' };
  assert.equal(assinaturaValida(base), true);
  assert.equal(assinaturaValida({ ...base, dataId: '124' }), false);
  assert.equal(assinaturaValida({ ...base, segredo: 'outro' }), false);
  assert.equal(assinaturaValida({ ...base, segredo: '' }), false);
  assert.equal(assinaturaValida({ ...base, xSignature: undefined }), false);
});

test('catálogo avisa a página que o Pix é pago pelo site', async () => {
  const c = await (await fetch(base + '/api/catalogo')).json();
  assert.equal(c.pixOnline, true);
});

test('Pix pelo site exige e-mail', async () => {
  const r = await post('/api/pedidos', pedidoPix({ email: 'sem-arroba' }));
  assert.equal(r.status, 400);
  assert.match((await r.json()).erro, /e-mail/);
});

test('pedido com Pix gera a cobrança certa e devolve o QR Code; só avisa o grupo quando pagar', async () => {
  const r = await post('/api/pedidos', pedidoPix());
  assert.equal(r.status, 201);
  const resp = await r.json();
  assert.equal(resp.total, 290); // 2 x 135 + entrega 20
  assert.match(resp.pix.copiaCola, /^00020126PIX/);
  assert.equal(resp.pix.qrBase64, 'iVBORw0KGgo=');

  const criacao = mp.chamadas.find((c) => c.method === 'POST' && c.body?.external_reference === resp.pix.referencia);
  assert.equal(criacao.body.transaction_amount, 290);
  assert.equal(criacao.body.payment_method_id, 'pix');
  assert.equal(criacao.body.payer.email, 'ana@email.com');
  assert.equal(criacao.body.notification_url, 'https://loja.test/webhooks/mercadopago');
  assert.equal(criacao.headers['X-Idempotency-Key'], resp.pix.referencia);
  assert.equal(criacao.headers.Authorization, 'Bearer TEST-token');

  const salvo = await banco.buscarPorReferencia(resp.pix.referencia);
  assert.equal(salvo.pix.situacao, 'aguardando');
  await esperar(20);
  assert.equal(enviados.length, 0, 'pedido ainda não pago não vai para o grupo');

  // O cliente paga: o aviso chega, o pedido vira pago e o grupo é avisado.
  mp.mudar(salvo.pix.mpId, { status: 'approved' });
  assert.equal((await avisar(salvo.pix.mpId)).status, 200);
  assert.equal((await banco.buscarPorReferencia(resp.pix.referencia)).pix.situacao, 'pago');
  const consulta = await (await fetch(`${base}/api/pix?ref=${resp.pix.referencia}`)).json();
  assert.deepEqual({ ...consulta, expiraEm: undefined }, { numero: resp.numero, situacao: 'pago', expiraEm: undefined });
  await esperar(20);
  assert.equal(enviados.length, 1);
  assert.match(enviados[0].texto, /Pix pago — Pedido #\d+/);
  assert.match(enviados[0].texto, /pago pelo site/);
});

test('aviso com assinatura errada é recusado e não marca nada como pago', async () => {
  const resp = await (await post('/api/pedidos', pedidoPix())).json();
  const salvo = await banco.buscarPorReferencia(resp.pix.referencia);
  mp.mudar(salvo.pix.mpId, { status: 'approved' });
  const r = await avisar(salvo.pix.mpId, { 'x-signature': 'ts=1,v1=falsa', 'x-request-id': 'r' });
  assert.equal(r.status, 401);
  assert.equal((await banco.buscarPorReferencia(resp.pix.referencia)).pix.situacao, 'aguardando');
});

test('valor pago diferente do pedido não vira "pago": fica para o dono conferir', async () => {
  const resp = await (await post('/api/pedidos', pedidoPix())).json();
  const salvo = await banco.buscarPorReferencia(resp.pix.referencia);
  mp.mudar(salvo.pix.mpId, { status: 'approved', transaction_amount: 1 });
  await avisar(salvo.pix.mpId);
  assert.equal((await banco.buscarPorReferencia(resp.pix.referencia)).pix.situacao, 'divergente');
});

test('se o aviso não chegar, a página do cliente e a conferência periódica descobrem o pagamento', async () => {
  const a = await (await post('/api/pedidos', pedidoPix())).json();
  const b = await (await post('/api/pedidos', pedidoPix({ nome: 'Bruno Melo' }))).json();
  const pa = await banco.buscarPorReferencia(a.pix.referencia);
  const pb = await banco.buscarPorReferencia(b.pix.referencia);

  mp.mudar(pa.pix.mpId, { status: 'approved' });
  const consulta = await (await fetch(`${base}/api/pix?ref=${a.pix.referencia}`)).json();
  assert.equal(consulta.situacao, 'pago');

  // Pix vencido sem pagamento: a conferência cancela o pedido, que sai dos relatórios.
  mp.mudar(pb.pix.mpId, { status: 'cancelled' });
  await conferirPixPendentes();
  const vencido = await banco.buscarPorReferencia(b.pix.referencia);
  assert.equal(vencido.pix.situacao, 'expirado');
  assert.equal(vencido.situacao, 'cancelado');
});

test('Mercado Pago fora do ar: o cliente recebe aviso claro e nenhum pedido fica gravado', async () => {
  const antes = (await banco.listarPedidos('2026-11-17')).length;
  mp.falhar(true);
  const r = await post('/api/pedidos', pedidoPix());
  assert.equal(r.status, 502);
  assert.match((await r.json()).erro, /Pix/);
  assert.equal((await banco.listarPedidos('2026-11-17')).length, antes);
});

test('cartão e dinheiro continuam pagos na entrega, sem passar pelo Mercado Pago', async () => {
  const chamadasAntes = mp.chamadas.length;
  const r = await post('/api/pedidos', pedidoPix({ pagamento: 'cartao', email: undefined }));
  assert.equal(r.status, 201);
  const resp = await r.json();
  assert.equal(resp.pix, undefined);
  assert.equal(mp.chamadas.length, chamadasAntes);
});

test('consulta de Pix com referência desconhecida não revela nada', async () => {
  assert.equal((await fetch(`${base}/api/pix?ref=00000000-0000-4000-8000-000000000000`)).status, 404);
  assert.equal((await fetch(`${base}/api/pix?ref=abc`)).status, 404);
});
