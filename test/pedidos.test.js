import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validarPedido, diaLocal, horaLocal, TAXA_ENTREGA } from '../src/pedidos.js';
import { montarResumo, textoDoRelatorio } from '../src/resumo.js';

const base = {
  nome: '  João   Silva ',
  telefone: '(98) 99115-8516',
  produto: 'touca-leon',
  quantidade: 2,
  pagamento: 'pix',
  retirada: 'loja',
};

test('pedido válido calcula o total no servidor', () => {
  const { pedido, erros } = validarPedido({ ...base, total: 1, precoUnitario: 1 });
  assert.equal(erros, undefined);
  assert.equal(pedido.nome, 'João Silva');
  assert.equal(pedido.telefone, '98991158516');
  assert.equal(pedido.total, 270);
});

test('entrega soma a taxa e exige endereço', () => {
  assert.match(validarPedido({ ...base, retirada: 'entrega' }).erros.join(), /endereço/);
  const { pedido } = validarPedido({ ...base, retirada: 'entrega', endereco: 'Rua A, 10, Centro' });
  assert.equal(pedido.total, 270 + TAXA_ENTREGA);
});

test('recusa campos inválidos', () => {
  const { erros } = validarPedido({ nome: 'x', telefone: '123', produto: 'outro', quantidade: 0, pagamento: 'boleto', retirada: 'drone' });
  assert.equal(erros.length, 6);
  assert.ok(validarPedido({ ...base, quantidade: 1.5 }).erros);
  assert.ok(validarPedido({ ...base, quantidade: 21 }).erros);
  assert.ok(validarPedido(null).erros);
});

test('ignora propriedades herdadas', () => {
  const herdado = Object.create({ ...base });
  assert.ok(validarPedido(herdado).erros);
  assert.ok(validarPedido({ ...base, pagamento: 'toString' }).erros);
});

test('troco só vale para dinheiro', () => {
  assert.equal(validarPedido({ ...base, pagamento: 'dinheiro', troco: '300,00' }).pedido.troco, 300);
  assert.equal(validarPedido({ ...base, troco: 300 }).pedido.troco, null);
  assert.ok(validarPedido({ ...base, pagamento: 'dinheiro', troco: 'abc' }).erros);
});

test('dia e hora no fuso de São Luís', () => {
  const quaseMeiaNoite = new Date('2026-11-13T02:30:00Z'); // 23:30 do dia 12 em UTC-3
  assert.equal(diaLocal(quaseMeiaNoite), '2026-11-12');
  assert.equal(horaLocal(quaseMeiaNoite), '23:30');
});

const p = (numero, extra) => ({ ...validarPedido({ ...base, ...extra }).pedido, numero, situacao: 'novo' });

test('resumo conta clientes, peças, pagamento e retirada sem cancelados', () => {
  const pedidos = [
    p(1, {}),
    p(2, { telefone: '98988887777', quantidade: 1, pagamento: 'dinheiro', retirada: 'entrega', endereco: 'Rua B, 5' }),
    { ...p(3, { telefone: '98911112222', pagamento: 'cartao' }), situacao: 'cancelado' },
    p(4, { quantidade: 1 }),
  ];
  const r = montarResumo(pedidos);
  assert.equal(r.pedidos, 3);
  assert.equal(r.clientes, 2);
  assert.equal(r.itens, 4);
  assert.equal(r.cancelados, 1);
  assert.equal(r.porPagamento.pix.pedidos, 2);
  assert.equal(r.porPagamento.cartao.pedidos, 0);
  assert.deepEqual(r.porRetirada, { loja: 2, entrega: 1 });
  assert.equal(r.valor, 270 + 145 + 135);

  const txt = textoDoRelatorio(pedidos, '2026-11-12');
  assert.match(txt, /12\/11\/2026/);
  assert.match(txt, /#2\* João Silva — 1x Caixa de touca Leon Barber — Dinheiro — Entrega/);
  assert.match(txt, /📍 Rua B, 5/);
  assert.doesNotMatch(txt, /#3/);
  assert.match(txt, /1 cancelado/);
});

test('relatório de dia sem pedidos', () => {
  assert.match(textoDoRelatorio([], '2026-11-12'), /Nenhum pedido hoje/);
});
