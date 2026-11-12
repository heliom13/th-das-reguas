// Conexão do número do robô com o WhatsApp (aparelho conectado via QR Code).
// A sessão fica no banco, então reinícios e novos deploys não pedem novo QR.
import makeWASocket, { BufferJSON, Browsers, DisconnectReason, initAuthCreds, proto } from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';

const NOME_DO_GRUPO = 'Pedidos TH das Réguas';

async function estadoDeAutenticacao(banco) {
  const ler = async (chave) => {
    const bruto = await banco.lerSessao(chave);
    return bruto ? JSON.parse(bruto, BufferJSON.reviver) : null;
  };
  const gravar = (chave, valor) =>
    banco.gravarSessao(chave, valor ? JSON.stringify(valor, BufferJSON.replacer) : null);

  const creds = (await ler('creds')) ?? initAuthCreds();
  return {
    state: {
      creds,
      keys: {
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
      },
    },
    salvar: () => gravar('creds', creds),
  };
}

export function criarWhatsApp({ banco, log = console, aoMudar = () => {} }) {
  let sock = null;
  let estado = 'desligado'; // desligado | aguardando-qr | conectando | conectado
  let qr = null;
  let numero = null;
  let erro = null;
  let tentativas = 0;
  let religar = null;
  let encerrando = false;

  const mudar = (novo, extra = {}) => {
    estado = novo;
    ({ qr = null, erro = null } = extra);
    aoMudar(status());
  };

  function status() {
    return { estado, qr, numero, erro };
  }

  async function conectar() {
    clearTimeout(religar);
    encerrando = false;
    if (sock) {
      sock.ev.removeAllListeners();
      sock.end(undefined);
    }
    mudar('conectando');
    const { state, salvar } = await estadoDeAutenticacao(banco);
    sock = makeWASocket({
      auth: state,
      browser: Browsers.ubuntu('Chrome'),
      logger: pino({ level: 'silent' }),
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    const atual = sock;
    sock.ev.on('creds.update', salvar);
    sock.ev.on('connection.update', async (u) => {
      if (atual !== sock) return;
      if (u.qr) {
        mudar('aguardando-qr', { qr: await QRCode.toDataURL(u.qr, { margin: 1, width: 300 }) });
      }
      if (u.connection === 'open') {
        tentativas = 0;
        numero = sock.user?.id?.split(':')[0]?.split('@')[0] ?? null;
        mudar('conectado');
        log.info?.(`WhatsApp conectado (${numero}).`);
      }
      if (u.connection === 'close') {
        const codigo = u.lastDisconnect?.error?.output?.statusCode;
        if (encerrando) return;
        if (codigo === DisconnectReason.loggedOut) {
          await banco.limparSessao();
          numero = null;
          sock = null;
          mudar('desligado', { erro: 'O aparelho foi desconectado no celular. Escaneie o QR Code de novo.' });
          return;
        }
        // Sem sessão salva e o QR expirou: para e espera o dono pedir um novo.
        if (!state.creds.registered && estado === 'aguardando-qr') {
          sock = null;
          mudar('desligado', { erro: 'O QR Code expirou. Clique em conectar para gerar outro.' });
          return;
        }
        tentativas += 1;
        const espera = codigo === DisconnectReason.restartRequired ? 500 : Math.min(60_000, 2000 * 2 ** tentativas);
        mudar('conectando', { erro: tentativas > 2 ? 'Conexão instável, tentando de novo…' : null });
        religar = setTimeout(() => conectar().catch((e) => log.error?.('WhatsApp:', e.message)), espera);
      }
    });
  }

  async function exigirConexao() {
    if (estado !== 'conectado' || !sock) throw new Error('WhatsApp do robô não está conectado.');
    return sock;
  }

  // Confirma o número no WhatsApp (resolve o nono dígito) e devolve o JID.
  async function jidDoNumero(telefone) {
    const s = await exigirConexao();
    let digitos = String(telefone).replace(/\D/g, '');
    if (digitos.length <= 11) digitos = '55' + digitos;
    const [achado] = (await s.onWhatsApp(digitos)) ?? [];
    if (!achado?.exists) throw new Error(`O número ${telefone} não tem WhatsApp.`);
    return achado.jid;
  }

  return {
    status,
    async iniciar() {
      if (await banco.lerSessao('creds')) await conectar();
    },
    conectar,
    async desconectar() {
      encerrando = true;
      clearTimeout(religar);
      if (sock) {
        await sock.logout().catch(() => {});
        sock.ev.removeAllListeners();
        sock.end(undefined);
      }
      sock = null;
      numero = null;
      await banco.limparSessao();
      mudar('desligado');
    },
    async criarGrupo(telefoneDono) {
      const s = await exigirConexao();
      const jidDono = await jidDoNumero(telefoneDono);
      const grupo = await s.groupCreate(NOME_DO_GRUPO, [jidDono]);
      return { jid: grupo.id, nome: grupo.subject ?? NOME_DO_GRUPO };
    },
    async enviar(jid, texto) {
      const s = await exigirConexao();
      await s.sendMessage(jid, { text: texto });
    },
    async parar() {
      encerrando = true;
      clearTimeout(religar);
      if (sock) {
        sock.ev.removeAllListeners();
        sock.end(undefined);
      }
    },
  };
}
