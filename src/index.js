import { criarApp } from './app.js';
import { criarAgenda } from './agenda.js';
import { criarBancoMemoria, criarBancoPostgres } from './banco.js';
import { criarSessoes } from './sessao.js';
import { criarWhatsApp } from './whatsapp.js';

const producao = process.env.NODE_ENV === 'production';
const porta = Number(process.env.PORT ?? 3000);
const log = console;

if (producao && !process.env.DATABASE_URL) {
  log.error('DATABASE_URL não configurada: os pedidos se perderiam a cada reinício.');
  process.exit(1);
}

const banco = process.env.DATABASE_URL
  ? await criarBancoPostgres(process.env.DATABASE_URL, { log })
  : criarBancoMemoria();
await banco.iniciar();

let app;
const whatsapp = criarWhatsApp({ banco, log, aoMudar: (s) => app?.avisar('whatsapp', s) });
const agenda = criarAgenda({ banco, whatsapp, log, aoMudar: () => app?.avisar('whatsapp', whatsapp.status()) });
const sessoes = criarSessoes({ senha: process.env.PAINEL_SENHA, segredo: process.env.SEGREDO_SESSAO || undefined });

app = criarApp({ banco, whatsapp, agenda, sessoes, producao, log });
app.servidor.listen(porta, () => {
  log.info(`TH das Réguas no ar na porta ${porta} (banco: ${banco.tipo}).`);
  if (!sessoes.habilitado) log.warn('PAINEL_SENHA não configurada: o painel fica bloqueado.');
});

// Só uma cópia do sistema conecta o WhatsApp e envia o relatório (num deploy, a
// nova espera a antiga sair). A trava fica no banco e some se o processo morrer.
const trava = banco.criarTrava();
let lider = false;
let encerrando = false;
whatsapp.liberar(false);

async function disputarTrava() {
  if (encerrando || lider) return;
  try {
    if (await trava.tentar()) {
      lider = true;
      whatsapp.liberar(true);
      agenda.iniciar();
      await whatsapp.iniciar();
      log.info('Esta cópia cuida do WhatsApp e do relatório.');
      return;
    }
  } catch (erro) {
    log.error('Trava do WhatsApp:', erro.message);
  }
  setTimeout(disputarTrava, 10_000);
}

trava.aoPerder(async () => {
  if (!lider) return;
  lider = false;
  agenda.parar();
  whatsapp.liberar(false);
  await whatsapp.parar();
  log.warn('Trava do WhatsApp perdida; tentando de novo.');
  if (!encerrando) setTimeout(disputarTrava, 5_000);
});
disputarTrava();

// No plano gratuito do Render o serviço dorme após 15 min sem acesso; com
// MANTER_ACORDADO=1 ele se chama a cada 10 min pelo endereço público.
const urlPublica = process.env.RENDER_EXTERNAL_URL;
if (process.env.MANTER_ACORDADO === '1' && urlPublica) {
  setInterval(() => fetch(`${urlPublica}/saude`).catch(() => {}), 10 * 60_000);
  log.info(`Mantendo acordado via ${urlPublica}/saude.`);
}

async function encerrar() {
  if (encerrando) return;
  encerrando = true;
  agenda.parar();
  await whatsapp.parar().catch(() => {});
  await trava.liberar();
  app.servidor.close();
  app.servidor.closeAllConnections?.();
  await banco.fechar();
  process.exit(0);
}
process.on('SIGTERM', encerrar);
process.on('SIGINT', encerrar);
process.on('unhandledRejection', (erro) => log.error('Erro não tratado:', erro));
