// Simula o servidor do WhatsApp para testar o ciclo de conexão do robô.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BufferJSON } from '@whiskeysockets/baileys';
import { criarBancoMemoria } from '../src/banco.js';
import { criarWhatsApp } from '../src/whatsapp.js';

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const fechar = (codigo) => ({ connection: 'close', lastDisconnect: { error: { output: { statusCode: codigo } } } });

function montar({ participantes = 2 } = {}) {
  const banco = criarBancoMemoria();
  const sockets = [];
  const enviadas = [];
  const fabricarSocket = (config) => {
    const ev = new EventEmitter();
    const s = {
      config,
      ev,
      user: null,
      encerrado: false,
      end() {
        this.encerrado = true;
      },
      async logout() {},
      async onWhatsApp(numero) {
        return numero.endsWith('0000') ? [] : [{ jid: `${numero}@s.whatsapp.net`, exists: true }];
      },
      async groupCreate(nome) {
        return { id: '123@g.us', subject: nome, size: participantes };
      },
      async groupMetadata() {
        return { participants: Array.from({ length: participantes }, (_, i) => ({ id: `${i}@lid` })) };
      },
      async groupInviteCode() {
        return 'CONVITE123';
      },
      async sendMessage(jid, conteudo) {
        enviadas.push({ jid, texto: conteudo.text });
        return { key: { id: `m${enviadas.length}` }, message: { conversation: conteudo.text } };
      },
    };
    sockets.push(s);
    return s;
  };
  const mudancas = [];
  const wa = criarWhatsApp({ banco, log: {}, aoMudar: (s) => mudancas.push(s.estado), fabricarSocket });
  return { banco, wa, sockets, enviadas, mudancas };
}

// Faz o pareamento como o WhatsApp real: QR, leitura, pedido de reinício (515) e conexão aberta.
async function parear({ wa, sockets }) {
  await wa.conectar();
  sockets[0].ev.emit('connection.update', { qr: 'ref,chave,identidade,adv' });
  await esperar(50);
  sockets[0].config.auth.creds.me = { id: '559899990000:7@s.whatsapp.net', name: 'Robô' };
  sockets[0].ev.emit('creds.update', {});
  sockets[0].ev.emit('connection.update', { isNewLogin: true, qr: undefined });
  sockets[0].ev.emit('connection.update', fechar(515));
  await esperar(400);
  sockets[1].user = { id: '559899990000:7@s.whatsapp.net' };
  sockets[1].ev.emit('connection.update', { connection: 'open' });
  await esperar(10);
}

test('ler o QR conecta de verdade: o reinício pedido pelo WhatsApp não é tratado como QR expirado', async () => {
  const t = montar();
  await t.wa.conectar();
  assert.equal(t.wa.status().estado, 'conectando');
  t.sockets[0].ev.emit('connection.update', { qr: 'ref,chave,identidade,adv' });
  await esperar(50);
  assert.equal(t.wa.status().estado, 'aguardando-qr');
  assert.match(t.wa.status().qr, /^data:image\/png;base64,/);

  t.sockets[0].config.auth.creds.me = { id: '559899990000:7@s.whatsapp.net' };
  t.sockets[0].ev.emit('creds.update', {});
  t.sockets[0].ev.emit('connection.update', fechar(515));
  await esperar(400);
  assert.equal(t.sockets.length, 2, 'abriu uma nova conexão');
  assert.equal(t.sockets[1].config.auth.creds.me.id, '559899990000:7@s.whatsapp.net', 'reaproveita a sessão recém-criada');

  t.sockets[1].user = { id: '559899990000:7@s.whatsapp.net' };
  t.sockets[1].ev.emit('connection.update', { connection: 'open' });
  await esperar(10);
  assert.deepEqual(t.wa.status(), { estado: 'conectado', qr: null, numero: '559899990000', erro: null });

  const salvo = JSON.parse(await t.banco.lerSessao('creds'), BufferJSON.reviver);
  assert.equal(salvo.me.id, '559899990000:7@s.whatsapp.net', 'sessão gravada no banco');
  await t.wa.parar();
});

test('reinício do servidor reconecta com a sessão do banco, sem QR', async () => {
  const t = montar();
  await parear(t);
  await t.wa.parar();

  const sockets = [];
  const wa2 = criarWhatsApp({
    banco: t.banco,
    log: {},
    fabricarSocket: (config) => {
      const s = { config, ev: new EventEmitter(), end() {}, user: { id: '559899990000:7@s.whatsapp.net' } };
      sockets.push(s);
      return s;
    },
  });
  await wa2.iniciar();
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].config.auth.creds.me.id, '559899990000:7@s.whatsapp.net');
  sockets[0].ev.emit('connection.update', { connection: 'open' });
  await esperar(10);
  assert.equal(wa2.status().estado, 'conectado');
  await wa2.parar();
});

test('sem sessão salva, iniciar não abre conexão nem gera QR sozinho', async () => {
  const t = montar();
  await t.wa.iniciar();
  assert.equal(t.sockets.length, 0);
  assert.equal(t.wa.status().estado, 'desligado');
});

test('QR não lido expira e para de tentar', async () => {
  const t = montar();
  await t.wa.conectar();
  t.sockets[0].ev.emit('connection.update', { qr: 'ref,chave,identidade,adv' });
  await esperar(50);
  t.sockets[0].ev.emit('connection.update', fechar(408));
  await esperar(50);
  assert.equal(t.wa.status().estado, 'desligado');
  assert.match(t.wa.status().erro, /expirou/);
  await esperar(400);
  assert.equal(t.sockets.length, 1, 'não ficou gerando QR sem ninguém olhando');
});

test('aparelho removido no celular apaga a sessão e pede QR de novo', async () => {
  const t = montar();
  await parear(t);
  t.sockets[1].ev.emit('connection.update', fechar(401));
  await esperar(20);
  assert.equal(t.wa.status().estado, 'desligado');
  assert.match(t.wa.status().erro, /desconectado no celular/);
  assert.equal(await t.banco.lerSessao('creds'), null);
});

test('queda comum reconecta sozinho; outra conexão no lugar espera antes de voltar', async () => {
  const t = montar();
  await parear(t);
  t.sockets[1].ev.emit('connection.update', fechar(428));
  await esperar(2200);
  assert.equal(t.sockets.length, 3, 'reconectou após a queda');
  t.sockets[2].ev.emit('connection.update', fechar(440));
  await esperar(50);
  assert.equal(t.wa.status().estado, 'conectando');
  assert.match(t.wa.status().erro, /Outra conexão/);
  await esperar(300);
  assert.equal(t.sockets.length, 3, 'não briga com a outra conexão');
  await t.wa.parar();
});

test('sem a trava do banco não conecta', async () => {
  const t = montar();
  t.wa.liberar(false);
  await assert.rejects(t.wa.conectar(), /reiniciando/);
  assert.equal(t.sockets.length, 0);
});

test('grupo com o dono; se a privacidade dele barrar, manda convite no privado', async () => {
  const t = montar();
  await parear(t);
  const g = await t.wa.criarGrupo('98991158516');
  assert.deepEqual(g, { jid: '123@g.us', nome: 'Pedidos TH das Réguas', donoNoGrupo: true, convite: null });
  await assert.rejects(t.wa.criarGrupo('98900000000'), /não tem WhatsApp/);

  const b = montar({ participantes: 1 });
  await parear(b);
  const g2 = await b.wa.criarGrupo('98991158516');
  assert.equal(g2.donoNoGrupo, false);
  assert.equal(g2.convite, 'https://chat.whatsapp.com/CONVITE123');
  assert.equal(b.enviadas.at(-1).jid, '5598991158516@s.whatsapp.net');
  assert.match(b.enviadas.at(-1).texto, /chat\.whatsapp\.com\/CONVITE123/);
  await t.wa.parar();
  await b.wa.parar();
});

test('enviar exige conexão e guarda a mensagem para reenvio', async () => {
  const t = montar();
  await assert.rejects(t.wa.enviar('123@g.us', 'oi'), /não está conectado/);
  await parear(t);
  await t.wa.enviar('123@g.us', 'relatório');
  assert.deepEqual(await t.sockets[1].config.getMessage({ id: 'm1' }), { conversation: 'relatório' });
  await t.wa.parar();
});
