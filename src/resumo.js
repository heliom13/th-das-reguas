import { PAGAMENTOS, RETIRADAS, centavos, reais } from './pedidos.js';

const ativos = (pedidos) => pedidos.filter((p) => p.situacao !== 'cancelado');

export function montarResumo(pedidos) {
  const lista = ativos(pedidos);
  const resumo = {
    pedidos: lista.length,
    clientes: new Set(lista.map((p) => p.telefone)).size,
    itens: 0,
    valor: 0,
    cancelados: pedidos.length - lista.length,
    porProduto: {},
    porPagamento: Object.fromEntries(Object.keys(PAGAMENTOS).map((k) => [k, { pedidos: 0, valor: 0 }])),
    porRetirada: Object.fromEntries(Object.keys(RETIRADAS).map((k) => [k, 0])),
  };
  for (const p of lista) {
    resumo.itens += p.quantidade;
    resumo.valor += p.total;
    resumo.porProduto[p.produtoNome] = (resumo.porProduto[p.produtoNome] ?? 0) + p.quantidade;
    resumo.porPagamento[p.pagamento].pedidos += 1;
    resumo.porPagamento[p.pagamento].valor += p.total;
    resumo.porRetirada[p.retirada] += 1;
  }
  resumo.valor = centavos(resumo.valor);
  for (const k of Object.keys(resumo.porPagamento)) resumo.porPagamento[k].valor = centavos(resumo.porPagamento[k].valor);
  return resumo;
}

// Uma linha por dia do período, incluindo os dias sem pedido.
export function resumoPorDia(pedidos, de, ate) {
  const dias = new Map();
  for (let d = new Date(`${de}T12:00:00Z`); d <= new Date(`${ate}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    dias.set(d.toISOString().slice(0, 10), []);
  }
  for (const p of pedidos) dias.get(p.dia)?.push(p);
  return [...dias].map(([dia, lista]) => {
    const r = montarResumo(lista);
    return { dia, clientes: r.clientes, pedidos: r.pedidos, itens: r.itens, valor: r.valor };
  });
}

const dataBr = (dia) => dia.split('-').reverse().join('/');

function descreverPagamento(p) {
  let txt = PAGAMENTOS[p.pagamento];
  if (p.pagamento === 'dinheiro' && p.troco) txt += ` (troco p/ ${reais(p.troco)})`;
  return txt;
}

// Texto enviado no grupo do WhatsApp e copiado pelo painel.
export function textoDoRelatorio(pedidos, dia) {
  const lista = ativos(pedidos).sort((a, b) => a.numero - b.numero);
  const r = montarResumo(pedidos);
  const linhas = [`*📦 Pedidos do dia ${dataBr(dia)}*`, ''];

  if (!lista.length) {
    linhas.push('Nenhum pedido neste dia.');
    if (r.cancelados) linhas.push(`(${r.cancelados} cancelado(s))`);
    return linhas.join('\n');
  }

  for (const p of lista) {
    linhas.push(`*#${p.numero}* ${p.nome} — ${p.quantidade}x ${p.produtoNome} — ${descreverPagamento(p)} — ${RETIRADAS[p.retirada]}`);
    if (p.retirada === 'entrega') linhas.push(`   📍 ${p.endereco}`);
    linhas.push(`   📱 ${p.telefone} · ${reais(p.total)}`);
  }

  const pag = Object.entries(PAGAMENTOS)
    .filter(([k]) => r.porPagamento[k].pedidos)
    .map(([k, nome]) => `${nome} ${r.porPagamento[k].pedidos} (${reais(r.porPagamento[k].valor)})`);

  linhas.push(
    '',
    '*Resumo*',
    `👥 ${r.clientes} cliente(s) · ${r.pedidos} pedido(s)`,
    ...Object.entries(r.porProduto).map(([nome, qtd]) => `🧢 ${qtd}x ${nome}`),
    `💳 ${pag.join(' · ')}`,
    `🏪 Retirada ${r.porRetirada.loja} · 🛵 Entrega ${r.porRetirada.entrega}`,
    `💰 Total ${reais(r.valor)}`,
  );
  if (r.cancelados) linhas.push(`(${r.cancelados} cancelado(s) fora da conta)`);
  return linhas.join('\n');
}

// Aviso curto no grupo quando entra um pedido (opcional).
export function textoDoAviso(p) {
  const linhas = [
    `🆕 *Pedido #${p.numero}* — ${p.nome}`,
    `${p.quantidade}x ${p.produtoNome} — ${descreverPagamento(p)} — ${RETIRADAS[p.retirada]}`,
  ];
  if (p.retirada === 'entrega') linhas.push(`📍 ${p.endereco}`);
  linhas.push(`📱 ${p.telefone} · ${reais(p.total)}`);
  return linhas.join('\n');
}
