// Conexão do número do robô com o WhatsApp (aparelho conectado via QR Code).
// A sessão fica no banco, então reinícios e novos deploys não pedem novo QR.
import makeWASocket, {
  BufferJSON, Browsers, DisconnectReason, initAuthCreds, isJidBroadcast, isJidNewsletter,
  jidNormalizedUser, makeCacheableSignalKeyStore, proto,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';

export const NOME_DO_GRUPO = 'Pedidos TH das Réguas';
const silencioso = pino({ level: 'silent' });

// Sessão no banco. Gravações da mesma chave são feitas em fila, na ordem em que
// acontecem, para uma credencial antiga nunca sobrescrever uma nova.
async function sessaoNoBanco(banco, log) {
  const filas = new Map();
  const gravar = (chave, valor) => {
    const json = valor ? JSON.stringify(valor, BufferJSON.replacer) : null;
    const anterior = filas.get(chave) ?? Promise.resolve();
    const atual = anterior
      .then(() => banco.gravarSessao(chave, json))
      .catch((e) => log.error?.('WhatsApp: falha ao gravar a sessão:', e.message));
    filas.set(chave, atual);
    atual.finally(() => filas.get(chave) === atual && filas.delete(chave));
    return atual;
  };
  const ler = async (chave) => {
    const bruto = await banco.lerSessao(chave);
    return bruto ? JSON.parse(bruto, BufferJSON.reviver) : null;
  };

  const creds = (await ler('creds')) ?? initAuthCreds();
  const chaves = {
    async get(tipo, ids) {
      const dados = {};
      await Promise.all(
        ids.map(async (id) => {
          let valor = await ler(`${tipo}-${id}`);
          if (tipo === 'app-state-sync-key' && valor) valor = proto.Message.AppStateSyncKeyData.fromObject(valor);
          dados[id] = valor;
        }),
      );
      return dados;
    },
    async set(dados) {
      const tarefas = [];
      for (const tipo in dados) {
        for (const id in dados[tipo]) tarefas.push(gravar(`${tipo}-${id}`, dados[tipo][id] ?? null));
      }
      await Promise.all(tarefas);
    },
  };
  return {
    state: { creds, keys: makeCacheableSignalKeyStore(chaves, silencioso) },
    salvar: () => gravar('creds', creds),
    pendentes: () => Promise.all([...filas.values()]),
  };
}

const digitos = (jid) => jidNormalizedUser(jid ?? '').split('@')[0];

export function criarWhatsApp({ banco, log = console, aoMudar = () => {}, fabricarSocket = makeWASocket }) {
  let sock = null;
  let auth = null;
  let estado = 'desligado'; // desligado | aguardando-qr | conectando | conectado
  let qr = null;
  let numero = null;
  let erro = null;
  let falhas = 0;
  let religar = null;
  let liberado = true;
  const enviadas = new Map(); // mensagens recentes, para o reenvio que o WhatsApp às vezes pede

  const status = () => ({ estado, qr, numero, erro });
  const mudar = (novo, extra = {}) => {
    estado = novo;
    qr = extra.qr ?? null;
    erro = extra.erro ?? null;
    aoMudar(status());
  };

  function encerrarSocket() {
    clearTimeout(religar);
    if (!sock) return;
    const s = sock;
    sock = null;
    s.ev.removeAllListeners();
    s.end(undefined);
  }

  function agendar(ms) {
    clearTimeout(religar);
    religar = setTimeout(() => conectar().catch((e) => log.error?.('WhatsApp:', e.message)), ms);
  }

  async function conectar() {
    if (!liberado) throw new Error('O sistema está reiniciando. Tente de novo em 1 minuto.');
    if (estado === 'conectado' && sock) return;
    encerrarSocket();
    mudar('conectando');
    auth ??= await sessaoNoBanco(banco, log);
    const atual = fabricarSocket({
      auth: auth.state,
      browser: Browsers.ubuntu('Chrome'),
      logger: silencioso,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      shouldIgnoreJid: (jid) => isJidBroadcast(jid) || isJidNewsletter(jid),
      getMessage: async (chave) => enviadas.get(chave.id),
    });
    sock = atual;
    atual.ev.on('creds.update', auth.salvar);
    atual.ev.on('connection.update', async (u) => {
      if (atual !== sock) return;
      if (u.qr) {
        mudar('aguardando-qr', { qr: await QRCode.toDataURL(u.qr, { margin: 1, width: 300 }) });
        return;
      }
      if (u.connection === 'open') {
        falhas = 0;
        numero = digitos(atual.user?.id);
        mudar('conectado');
        log.info?.(`WhatsApp conectado (${numero}).`);
        return;
      }
      if (u.connection !== 'close') return;

      const codigo = u.lastDisconnect?.error?.output?.statusCode;
      const temSessao = Boolean(auth?.state.creds.me);
      sock = null;

      // Logo depois de ler o QR, o WhatsApp sempre pede para reiniciar a conexão.
      if (codigo === DisconnectReason.restartRequired) {
        await auth.pendentes();
        mudar('conectando');
        return agendar(300);
      }
      if (codigo === DisconnectReason.loggedOut) {
        auth = null;
        numero = null;
        await banco.limparSessao();
        return mudar('desligado', { erro: 'O aparelho foi desconectado no celular do robô. Clique em Conectar e leia o QR Code de novo.' });
      }
      if (codigo === 403) {
        return mudar('desligado', { erro: 'O WhatsApp recusou este número (pode ter sido bloqueado).' });
      }
      if (!temSessao) {
        auth = null;
        const expirou = codigo === DisconnectReason.timedOut;
        return mudar('desligado', {
          erro: expirou ? 'O QR Code expirou. Clique em Conectar para gerar outro.' : 'Não foi possível gerar o QR Code. Tente de novo.',
        });
      }
      if (codigo === DisconnectReason.connectionReplaced) {
        // Outra cópia do sistema (ex.: durante um deploy) assumiu; espera ela sair.
        mudar('conectando', { erro: 'Outra conexão assumiu o WhatsApp; tentando de novo em instantes.' });
        return agendar(30_000);
      }
      falhas += 1;
      mudar('conectando', { erro: falhas >= 3 ? 'Conexão instável, tentando de novo…' : null });
      agendar(Math.min(60_000, 1000 * 2 ** falhas));
    });
  }

  async function exigirConexao() {
    if (estado !== 'conectado' || !sock) throw new Error('O WhatsApp do robô não está conectado.');
    return sock;
  }

  // Confirma o número no WhatsApp (resolve o nono dígito) e devolve o JID.
  async function jidDoNumero(telefone) {
    const s = await exigirConexao();
    let d = String(telefone).replace(/\D/g, '');
    if (d.length <= 11) d = '55' + d;
    const [achado] = (await s.onWhatsApp(d)) ?? [];
    if (!achado?.exists) throw new Error(`O número ${telefone} não tem WhatsApp.`);
    return achado.jid;
  }

  async function enviar(jid, texto) {
    const s = await exigirConexao();
    const msg = await s.sendMessage(jid, { text: texto });
    if (msg?.key?.id) {
      enviadas.set(msg.key.id, msg.message);
      if (enviadas.size > 200) enviadas.delete(enviadas.keys().next().value);
    }
  }

  return {
    status,
    conectar,
    enviar,
    // Só a cópia do sistema que tem a trava do banco pode conectar.
    liberar(sim) {
      liberado = sim;
    },
    async iniciar() {
      if (await banco.lerSessao('creds')) await conectar();
    },
    async desconectar() {
      clearTimeout(religar);
      const s = sock;
      sock = null;
      if (s) {
        s.ev.removeAllListeners();
        await s.logout().catch(() => {});
        s.end(undefined);
      }
      if (auth) await auth.pendentes();
      auth = null;
      numero = null;
      await banco.limparSessao();
      mudar('desligado');
    },
    async parar() {
      encerrarSocket();
      if (auth) await auth.pendentes();
      auth = null;
      if (estado !== 'desligado') mudar('desligado');
    },
    // Cria o grupo com o dono. Se a privacidade dele não deixar o robô adicioná-lo,
    // manda o link de convite no privado.
    async criarGrupo(telefoneDono) {
      const s = await exigirConexao();
      const jidDono = await jidDoNumero(telefoneDono);
      const grupo = await s.groupCreate(NOME_DO_GRUPO, [jidDono]);
      let donoNoGrupo = (grupo.size ?? grupo.participants?.length ?? 0) >= 2;
      try {
        const meta = await s.groupMetadata(grupo.id);
        donoNoGrupo = meta.participants.length >= 2;
      } catch {
        // mantém a leitura da criação
      }
      let convite = null;
      if (!donoNoGrupo) {
        const codigo = await s.groupInviteCode(grupo.id);
        convite = `https://chat.whatsapp.com/${codigo}`;
        await enviar(
          jidDono,
          `Olá! Sou o robô de pedidos da TH das Réguas. Toque no link para entrar no grupo onde mando o relatório de pedidos todo dia:\n${convite}`,
        );
      }
      return { jid: grupo.id, nome: grupo.subject ?? NOME_DO_GRUPO, donoNoGrupo, convite };
    },
  };
}
