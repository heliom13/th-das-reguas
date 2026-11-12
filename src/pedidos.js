// Regras do pedido: catálogo, validação e cálculo do total no servidor.
// O preço nunca vem do navegador.

export const FUSO = 'America/Fortaleza';

export const CATALOGO = [
  { id: 'touca-leon', nome: 'Caixa de touca Leon Barber', detalhe: 'Touca para reflexo + agulha de brinde', preco: 135, precoAntigo: 140 },
];

export const TAXA_ENTREGA = 10;
export const MAX_QUANTIDADE = 20;

export const PAGAMENTOS = { pix: 'Pix', cartao: 'Cartão', dinheiro: 'Dinheiro' };
export const RETIRADAS = { loja: 'Retirada na loja', entrega: 'Entrega' };
export const SITUACOES = { novo: 'Novo', confirmado: 'Confirmado', entregue: 'Entregue', cancelado: 'Cancelado' };

const texto = (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');

// Dia e hora no fuso da loja (São Luís, UTC-3).
export function diaLocal(data = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' }).format(data);
}

export function horaLocal(data = new Date()) {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(data);
}

export function validarPedido(dados) {
  const erros = [];
  if (!dados || typeof dados !== 'object') return { erros: ['Pedido inválido.'] };
  const campo = (k) => (Object.prototype.hasOwnProperty.call(dados, k) ? dados[k] : undefined);

  const nome = texto(campo('nome'));
  if (nome.length < 2 || nome.length > 80) erros.push('Informe seu nome.');

  const telefone = String(campo('telefone') ?? '').replace(/\D/g, '');
  if (telefone.length < 10 || telefone.length > 13) erros.push('Informe um WhatsApp com DDD.');

  const produto = CATALOGO.find((p) => p.id === campo('produto'));
  if (!produto) erros.push('Escolha um produto.');

  const quantidade = Number(campo('quantidade'));
  if (!Number.isInteger(quantidade) || quantidade < 1 || quantidade > MAX_QUANTIDADE) {
    erros.push(`Quantidade deve ser de 1 a ${MAX_QUANTIDADE}.`);
  }

  const pagamento = campo('pagamento');
  if (!Object.hasOwn(PAGAMENTOS, pagamento ?? '')) erros.push('Escolha a forma de pagamento.');

  const retirada = campo('retirada');
  if (!Object.hasOwn(RETIRADAS, retirada ?? '')) erros.push('Escolha retirada na loja ou entrega.');

  const endereco = texto(campo('endereco'));
  if (retirada === 'entrega' && (endereco.length < 5 || endereco.length > 200)) {
    erros.push('Informe o endereço de entrega.');
  }

  let troco = null;
  const trocoBruto = campo('troco');
  if (pagamento === 'dinheiro' && trocoBruto !== undefined && trocoBruto !== null && trocoBruto !== '') {
    troco = Number(String(trocoBruto).replace(',', '.'));
    if (!Number.isFinite(troco) || troco < 0 || troco > 10000) erros.push('Valor do troco inválido.');
  }

  const observacao = texto(campo('observacao')).slice(0, 300);

  if (erros.length) return { erros };

  const subtotal = produto.preco * quantidade;
  const entrega = retirada === 'entrega' ? TAXA_ENTREGA : 0;
  return {
    pedido: {
      nome,
      telefone,
      produto: produto.id,
      produtoNome: produto.nome,
      precoUnitario: produto.preco,
      quantidade,
      pagamento,
      retirada,
      endereco: retirada === 'entrega' ? endereco : '',
      troco,
      observacao,
      total: subtotal + entrega,
    },
  };
}

export const reais = (v) => 'R$ ' + Number(v).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
