// Planilha CSV dos pedidos, no formato que o Excel em português abre direto
// (separador ";", vírgula decimal e BOM para os acentos).
import { PAGAMENTOS, RETIRADAS, SITUACOES, horaLocal } from './pedidos.js';

const COLUNAS = [
  'Dia', 'Pedido', 'Hora', 'Cliente', 'WhatsApp', 'Produto', 'Quantidade', 'Preço unitário',
  'Taxa de entrega', 'Total', 'Pagamento', 'Troco para', 'Recebimento', 'Endereço', 'Situação',
];

const numero = (v) => (v === null || v === undefined || v === '' ? '' : Number(v).toFixed(2).replace('.', ','));

// Aspas em tudo; fórmulas digitadas pelo cliente viram texto (evita injeção no Excel).
function celula(valor) {
  let s = String(valor ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function csvDosPedidos(pedidos) {
  const linhas = [COLUNAS.map(celula).join(';')];
  for (const p of pedidos) {
    linhas.push(
      [
        p.dia.split('-').reverse().join('/'),
        p.numero,
        horaLocal(new Date(p.criadoEm)),
        p.nome,
        p.telefone,
        p.produtoNome,
        p.quantidade,
        numero(p.precoUnitario),
        numero(p.taxaEntrega ?? (p.retirada === 'entrega' ? p.total - p.precoUnitario * p.quantidade : 0)),
        numero(p.total),
        PAGAMENTOS[p.pagamento] ?? p.pagamento,
        numero(p.troco),
        RETIRADAS[p.retirada] ?? p.retirada,
        p.endereco,
        SITUACOES[p.situacao] ?? p.situacao,
      ]
        .map(celula)
        .join(';'),
    );
  }
  return '﻿' + linhas.join('\r\n') + '\r\n';
}
