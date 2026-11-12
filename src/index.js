import { criarApp } from './app.js';
import { criarAgenda } from './agenda.js';
import { criarBancoMemoria, criarBancoPostgres } from './banco.js';
import { criarSessoes } from './sessao.js';
import { criarWhatsApp } from './whatsapp.js';

const producao = process.env.NODE_ENV === 'production';
const porta = Number(process.env.PORT ?? 3000);

if (producao && !process.env.DATABASE_URL) {
  console.error('DATABASE_URL não configurada: os pedidos se perderiam a cada reinício.');
  process.exit(1);
}

const banco = process.env.DATABASE_URL ? await criarBancoPostgres(process.env.DATABASE_URL) : criarBancoMemoria();
await banco.iniciar();

let app;
const whatsapp = criarWhatsApp({ banco, aoMudar: (s) => app?.avisar('whatsapp', s) });
const agenda = criarAgenda({ banco, whatsapp, aoMudar: () => app?.avisar('whatsapp', whatsapp.status()) });
const sessoes = criarSessoes({ senha: process.env.PAINEL_SENHA, segredo: process.env.SEGREDO_SESSAO || undefined });

app = criarApp({ banco, whatsapp, agenda, sessoes, producao });
app.servidor.listen(porta, () => {
  console.log(`TH das Réguas no ar na porta ${porta} (banco: ${banco.tipo}).`);
  if (!sessoes.habilitado) console.warn('PAINEL_SENHA não configurada: o painel fica bloqueado.');
});

whatsapp.iniciar().catch((e) => console.error('WhatsApp:', e.message));
agenda.iniciar();

const encerrar = async () => {
  agenda.parar();
  await whatsapp.parar();
  app.servidor.close();
  await banco.fechar();
  process.exit(0);
};
process.on('SIGTERM', encerrar);
process.on('SIGINT', encerrar);
