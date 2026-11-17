// Pix pelo Mercado Pago (API de pagamentos v1). Só liga com MP_ACCESS_TOKEN configurado.
// O aviso (webhook) nunca é confiado sozinho: o pagamento é sempre consultado na API.
import { createHmac, timingSafeEqual } from 'node:crypto';

const API = 'https://api.mercadopago.com';
const VALIDADE_MINUTOS = 60;

// Situação do pagamento no Mercado Pago → situação guardada no pedido.
export function situacaoDoPagamento(status) {
  if (status === 'approved') return 'pago';
  if (status === 'refunded' || status === 'charged_back') return 'estornado';
  if (status === 'cancelled' || status === 'rejected' || status === 'expired') return 'expirado';
  return 'aguardando';
}

// Assinatura do webhook: HMAC-SHA256 de "id:<data.id>;request-id:<x-request-id>;ts:<ts>;"
// com a chave secreta da aplicação, comparado ao v1 do cabeçalho x-signature.
export function assinaturaValida({ segredo, xSignature, xRequestId, dataId }) {
  if (!segredo || typeof xSignature !== 'string') return false;
  const partes = Object.fromEntries(
    xSignature.split(',').map((p) => p.split('=').map((s) => s.trim())).filter((p) => p.length === 2),
  );
  if (!partes.ts || !partes.v1) return false;
  let manifesto = '';
  if (dataId) manifesto += `id:${String(dataId).toLowerCase()};`;
  if (xRequestId) manifesto += `request-id:${xRequestId};`;
  manifesto += `ts:${partes.ts};`;
  const esperado = Buffer.from(createHmac('sha256', segredo).update(manifesto).digest('hex'));
  const recebido = Buffer.from(partes.v1);
  return esperado.length === recebido.length && timingSafeEqual(esperado, recebido);
}

export function criarMercadoPago({ token, segredoWebhook, urlNotificacao, fetchImpl = fetch, agora = () => new Date() }) {
  async function chamar(caminho, { metodo = 'GET', corpo, idempotencia } = {}) {
    const resposta = await fetchImpl(API + caminho, {
      method: metodo,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(idempotencia ? { 'X-Idempotency-Key': idempotencia } : {}),
      },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const dados = await resposta.json().catch(() => ({}));
    if (!resposta.ok) {
      const motivo = dados?.message || dados?.error || `HTTP ${resposta.status}`;
      throw new Error(`Mercado Pago recusou: ${motivo}`);
    }
    return dados;
  }

  const resumir = (p) => ({
    id: String(p.id),
    status: p.status,
    situacao: situacaoDoPagamento(p.status),
    referencia: p.external_reference ?? null,
    valor: Number(p.transaction_amount),
  });

  return {
    habilitado: Boolean(token),
    webhookAssinado: Boolean(segredoWebhook),

    // Cria a cobrança Pix do pedido. `referencia` liga o pagamento ao pedido e também
    // serve de chave de idempotência (repetir a chamada não cobra duas vezes).
    async criarPix({ referencia, valor, descricao, email, nome }) {
      const vence = new Date(agora().getTime() + VALIDADE_MINUTOS * 60_000);
      const [primeiro, ...resto] = nome.split(' ');
      const p = await chamar('/v1/payments', {
        metodo: 'POST',
        idempotencia: referencia,
        corpo: {
          transaction_amount: valor,
          description: descricao,
          payment_method_id: 'pix',
          external_reference: referencia,
          date_of_expiration: vence.toISOString().replace('Z', '+00:00'),
          ...(urlNotificacao ? { notification_url: urlNotificacao } : {}),
          payer: { email, first_name: primeiro, last_name: resto.join(' ') || undefined },
        },
      });
      const dados = p.point_of_interaction?.transaction_data ?? {};
      if (!dados.qr_code) throw new Error('Mercado Pago não devolveu o código do Pix.');
      return {
        ...resumir(p),
        copiaCola: dados.qr_code,
        qrBase64: dados.qr_code_base64 ?? null,
        expiraEm: p.date_of_expiration ? new Date(p.date_of_expiration).toISOString() : vence.toISOString(),
      };
    },

    async consultar(id) {
      if (!/^\d{1,20}$/.test(String(id))) throw new Error('Pagamento inválido.');
      return resumir(await chamar(`/v1/payments/${id}`));
    },

    assinaturaValida: (dados) => assinaturaValida({ segredo: segredoWebhook, ...dados }),
  };
}
