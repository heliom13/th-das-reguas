// Login do painel: senha única (PAINEL_SENHA) e cookie assinado com HMAC.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const DURACAO = 12 * 60 * 60 * 1000;
const hash = (v) => createHash('sha256').update(String(v)).digest();

export function criarSessoes({ senha, segredo = randomBytes(32).toString('hex'), agora = () => Date.now() }) {
  const assinar = (v) => createHmac('sha256', segredo).update(v).digest('base64url');

  return {
    habilitado: Boolean(senha),
    conferirSenha(tentativa) {
      if (!senha || typeof tentativa !== 'string') return false;
      return timingSafeEqual(hash(tentativa), hash(senha));
    },
    emitir() {
      const validade = String(agora() + DURACAO);
      return `${validade}.${assinar(validade)}`;
    },
    valida(token) {
      if (typeof token !== 'string') return false;
      const [validade, assinatura] = token.split('.');
      if (!validade || !assinatura) return false;
      const esperado = Buffer.from(assinar(validade));
      const recebido = Buffer.from(assinatura);
      return esperado.length === recebido.length && timingSafeEqual(esperado, recebido) && Number(validade) > agora();
    },
    duracaoSegundos: DURACAO / 1000,
  };
}

export function lerCookie(req, nome) {
  for (const parte of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = parte.trim().split('=');
    if (k === nome) return decodeURIComponent(v.join('='));
  }
  return null;
}

// Limite simples por IP (janela fixa), em memória.
export function criarLimite({ maximo, janela }) {
  const contagem = new Map();
  return (chave, agora = Date.now()) => {
    const atual = contagem.get(chave);
    if (!atual || atual.fim < agora) {
      if (contagem.size > 5000) contagem.clear();
      contagem.set(chave, { n: 1, fim: agora + janela });
      return true;
    }
    atual.n += 1;
    return atual.n <= maximo;
  };
}
