import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOGO_PADRAO, validarCatalogo, validarPedido, diaLocal, horaLocal } from '../src/pedidos.js';
import { montarResumo, resumoPorDia, textoDoAviso, textoDoRelatorio } from '../src/resumo.js';
import { csvDosPedidos } from '../src/exportar.js';

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
  assert.equal(pedido.taxaEntrega, 0);
});

test('entrega soma a taxa do catálogo e exige endereço', () => {
  assert.match(validarPedido({ ...base, retirada: 'entrega' }).erros.join(), /endereço/);
  const { pedido } = validarPedido({ ...base, retirada: 'entrega', endereco: 'Rua A, 10, Centro' });
  assert.equal(pedido.total, 270 + CATALOGO_PADRAO.taxaEntrega);
  const outra = { ...CATALOGO_PADRAO, taxaEntrega: 7.5 };
  assert.equal(validarPedido({ ...base, retirada: 'entrega', endereco: 'Rua A, 10' }, outra).pedido.total, 277.5);
});

test('recusa campos inválidos', () => {
  const { erros } = validarPedido({ nome: 'x', telefone: '123', produto: 'outro', quantidade: 0, pagamento: 'boleto', retirada: 'drone' });
  assert.equal(erros.length, 6);
  assert.ok(validarPedido({ ...base, quantidade: 1.5 }).erros);
  assert.ok(validarPedido({ ...base, quantidade: 21 }).erros);
  assert.ok(validarPedido(null).erros);
});

test('produto desativado não pode ser pedido', () => {
  const catalogo = { produtos: [{ ...CATALOGO_PADRAO.produtos[0], ativo: false }], taxaEntrega: 10 };
  assert.match(validarPedido(base, catalogo).erros.join(), /produto/);
});

test('ignora propriedades herdadas', () => {
  const herdado = Object.create({ ...base });
  assert.ok(validarPedido(herdado).erros);
  assert.ok(validarPedido({ ...base, pagamento: 'toString' }).erros);
});

test('troco só vale para dinheiro e aceita "R$ 200,50"', () => {
  assert.equal(validarPedido({ ...base, pagamento: 'dinheiro', troco: 'R$ 200,50' }).pedido.troco, 200.5);
  assert.equal(validarPedido({ ...base, troco: 300 }).pedido.troco, null);
  assert.ok(validarPedido({ ...base, pagamento: 'dinheiro', troco: '99999' }).erros);
});

test('totais com centavos não acumulam erro de arredondamento', () => {
  const catalogo = { produtos: [{ id: 'x', nome: 'Agulha', preco: 0.1, ativo: true }], taxaEntrega: 0.2 };
  const { pedido } = validarPedido({ ...base, produto: 'x', quantidade: 3, retirada: 'entrega', endereco: 'Rua B, 1' }, catalogo);
  assert.equal(pedido.total, 0.5);
});

test('dia e hora no fuso de São Luís', () => {
  const quaseMeiaNoite = new Date('2026-11-13T02:30:00Z'); // 23:30 do dia 12 em UTC-3
  assert.equal(diaLocal(quaseMeiaNoite), '2026-11-12');
  assert.equal(horaLocal(quaseMeiaNoite), '23:30');
});

test('catálogo editado no painel é validado', () => {
  const ok = validarCatalogo({
    produtos: [
      { id: 'touca-leon', nome: 'Touca P', preco: '135,00', precoAntigo: '140', ativo: true },
      { nome: 'Touca Ç M', detalhe: 'Tamanho M', preco: 145, ativo: false },
    ],
    taxaEntrega: '12,50',
  });
  assert.equal(ok.erros, undefined);
  assert.equal(ok.catalogo.taxaEntrega, 12.5);
  assert.equal(ok.catalogo.produtos[0].preco, 135);
  assert.equal(ok.catalogo.produtos[0].precoAntigo, 140);
  assert.match(ok.catalogo.produtos[1].id, /^touca-c-m-[0-9a-f]{4}$/);
  assert.equal(ok.catalogo.produtos[1].ativo, false);

  assert.match(validarCatalogo({ produtos: [] }).erros.join(), /pelo menos um/);
  assert.match(validarCatalogo({ produtos: [{ nome: 'A', preco: 10 }] }).erros.join(), /nome/);
  assert.match(validarCatalogo({ produtos: [{ nome: 'Touca', preco: 0 }] }).erros.join(), /preço inválido/);
  assert.match(validarCatalogo({ produtos: [{ nome: 'Touca', preco: 100, precoAntigo: 90 }] }).erros.join(), /preço antigo/);
  assert.match(
    validarCatalogo({ produtos: [{ id: 'a', nome: 'Touca', preco: 1 }, { id: 'a', nome: 'Outra', preco: 2 }] }).erros.join(),
    /repetido/,
  );
  assert.match(validarCatalogo({ produtos: [{ nome: 'Touca', preco: 1 }], taxaEntrega: -1 }).erros.join(), /Taxa/);
});

const p = (numero, extra, dia = '2026-11-12') => ({
  ...validarPedido({ ...base, ...extra }).pedido,
  numero,
  dia,
  criadoEm: '2026-11-12T13:05:00.000Z',
  situacao: 'novo',
});

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
  assert.match(textoDoRelatorio([], '2026-11-12'), /Nenhum pedido neste dia/);
});

test('aviso de pedido novo', () => {
  const txt = textoDoAviso(p(7, { pagamento: 'dinheiro', troco: '200', retirada: 'entrega', endereco: 'Rua C, 9' }));
  assert.match(txt, /Pedido #7\* — João Silva/);
  assert.match(txt, /troco p\/ R\$ 200,00/);
  assert.match(txt, /📍 Rua C, 9/);
});

test('resumo por dia inclui os dias sem pedido', () => {
  const linhas = resumoPorDia([p(1, {}, '2026-11-10'), p(1, { quantidade: 1 }, '2026-11-12')], '2026-11-10', '2026-11-12');
  assert.deepEqual(linhas.map((l) => [l.dia, l.itens]), [['2026-11-10', 2], ['2026-11-11', 0], ['2026-11-12', 1]]);
});

test('planilha CSV abre no Excel e neutraliza fórmulas', () => {
  const csv = csvDosPedidos([p(1, { nome: '=HYPERLINK("http://x")', pagamento: 'dinheiro', troco: '50', quantidade: 1 })]);
  assert.ok(csv.startsWith('﻿"Dia";"Pedido"'));
  const linha = csv.trim().split('\r\n')[1];
  assert.match(linha, /^"12\/11\/2026";"1";"10:05";"'=HYPERLINK\(""http:\/\/x""\)"/);
  assert.match(linha, /"135,00";"0,00";"135,00";"Dinheiro";"50,00";"Retirada na loja";"";"Novo"$/);
});
