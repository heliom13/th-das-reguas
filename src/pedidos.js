// Regras do pedido: catálogo, validação e cálculo do total no servidor.
// O preço nunca vem do navegador.
import { randomBytes } from 'node:crypto';

export const FUSO = 'America/Fortaleza';

export const CATALOGO_PADRAO = {
  produtos: [
    {
      id: 'touca-leon',
      nome: 'Caixa de touca Leon Barber',
      detalhe: 'Touca para reflexo + agulha de brinde',
      preco: 135,
      precoAntigo: 140,
      ativo: true,
    },
  ],
  taxaEntrega: 10,
};

export const MAX_QUANTIDADE = 20;
export const MAX_PRODUTOS = 30;

export const PAGAMENTOS = { pix: 'Pix', cartao: 'Cartão', dinheiro: 'Dinheiro' };
export const RETIRADAS = { loja: 'Retirada na loja', entrega: 'Entrega' };
export const SITUACOES = { novo: 'Novo', confirmado: 'Confirmado', entregue: 'Entregue', cancelado: 'Cancelado' };

const texto = (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');
const proprio = (obj, k) => (Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : undefined);
export const centavos = (v) => Math.round(v * 100) / 100;

// Dia e hora no fuso da loja (São Luís, UTC-3).
export function diaLocal(data = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' }).format(data);
}

export function horaLocal(data = new Date()) {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(data);
}

export function validarPedido(dados, catalogo = CATALOGO_PADRAO) {
  const erros = [];
  if (!dados || typeof dados !== 'object') return { erros: ['Pedido inválido.'] };
  const campo = (k) => proprio(dados, k);

  const nome = texto(campo('nome'));
  if (nome.length < 2 || nome.length > 80) erros.push('Informe seu nome.');

  const telefone = String(campo('telefone') ?? '').replace(/\D/g, '');
  if (telefone.length < 10 || telefone.length > 13) erros.push('Informe um WhatsApp com DDD.');

  const produto = catalogo.produtos.find((p) => p.ativo && p.id === campo('produto'));
  if (!produto) erros.push('Escolha um produto disponível.');

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
    troco = Number(String(trocoBruto).replace(/[^\d,.]/g, '').replace(',', '.'));
    if (!Number.isFinite(troco) || troco < 0 || troco > 10000) erros.push('Valor do troco inválido.');
    else troco = centavos(troco);
  }

  const observacao = texto(campo('observacao')).slice(0, 300);

  if (erros.length) return { erros };

  const entrega = retirada === 'entrega' ? catalogo.taxaEntrega : 0;
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
      taxaEntrega: entrega,
      troco,
      observacao,
      total: centavos(produto.preco * quantidade + entrega),
    },
  };
}

function lerPreco(v) {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[^\d,.]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? centavos(n) : NaN;
}

const slug = (nome) =>
  nome.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'produto';

// Valida o catálogo editado no painel.
export function validarCatalogo(dados) {
  const erros = [];
  const lista = dados && Array.isArray(proprio(dados, 'produtos')) ? proprio(dados, 'produtos') : null;
  if (!lista || !lista.length) return { erros: ['Cadastre pelo menos um produto.'] };
  if (lista.length > MAX_PRODUTOS) return { erros: [`No máximo ${MAX_PRODUTOS} produtos.`] };

  const ids = new Set();
  const produtos = lista.map((p, i) => {
    const n = i + 1;
    if (!p || typeof p !== 'object') {
      erros.push(`Produto ${n}: inválido.`);
      return null;
    }
    const nome = texto(proprio(p, 'nome'));
    if (nome.length < 2 || nome.length > 80) erros.push(`Produto ${n}: informe o nome.`);
    const detalhe = texto(proprio(p, 'detalhe')).slice(0, 120);
    const preco = lerPreco(proprio(p, 'preco'));
    if (!(preco > 0 && preco <= 100000)) erros.push(`${nome || `Produto ${n}`}: preço inválido.`);
    const antigoBruto = proprio(p, 'precoAntigo');
    let precoAntigo = null;
    if (antigoBruto !== undefined && antigoBruto !== null && antigoBruto !== '') {
      precoAntigo = lerPreco(antigoBruto);
      if (!(precoAntigo > preco && precoAntigo <= 100000)) {
        erros.push(`${nome || `Produto ${n}`}: o preço antigo precisa ser maior que o preço atual.`);
      }
    }
    let id = proprio(p, 'id');
    if (typeof id !== 'string' || !/^[a-z0-9-]{1,60}$/.test(id)) id = `${slug(nome)}-${randomBytes(2).toString('hex')}`;
    if (ids.has(id)) erros.push(`${nome}: produto repetido.`);
    ids.add(id);
    return { id, nome, detalhe, preco, precoAntigo, ativo: proprio(p, 'ativo') !== false };
  });

  const taxaEntrega = lerPreco(proprio(dados, 'taxaEntrega') ?? 0);
  if (!(taxaEntrega >= 0 && taxaEntrega <= 1000)) erros.push('Taxa de entrega inválida.');

  return erros.length ? { erros } : { catalogo: { produtos, taxaEntrega } };
}

export const reais = (v) => 'R$ ' + Number(v).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
