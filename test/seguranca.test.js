import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { criarApp } from '../src/app.js';
import { criarBancoMemoria } from '../src/banco.js';
import { criarSessoes } from '../src/sessao.js';

const whatsapp = { status: () => ({ estado: 'desligado', qr: null }) };
const sessoes = criarSessoes({ senha: 'senha-forte', segredo: 'segredo-fixo' });
const { servidor } = criarApp({ banco: criarBancoMemoria(), whatsapp, sessoes, producao: true, log: {} });
let base;

before(async () => {
  await new Promise((ok) => servidor.listen(0, ok));
  base = `http://127.0.0.1:${servidor.address().port}`;
});
after(() => servidor.close());

const entrar = (senha, cabecalhos = {}) =>
  fetch(base + '/api/painel/entrar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cabecalhos },
    body: JSON.stringify({ senha }),
  });

test('páginas saem com cabeçalhos de segurança; o painel não aceita script embutido', async () => {
  const site = await fetch(base + '/');
  const painel = await fetch(base + '/painel');
  for (const r of [site, painel]) {
    assert.match(r.headers.get('strict-transport-security'), /max-age=31536000/);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(r.headers.get('permissions-policy'), /camera=\(\)/);
  }
  assert.match(site.headers.get('content-security-policy'), /script-src 'self' 'unsafe-inline'/);
  assert.match(painel.headers.get('content-security-policy'), /script-src 'self'$/);
});

test('em produção o cookie do painel é __Host- e Secure', async () => {
  const r = await entrar('senha-forte', { 'X-Forwarded-For': '10.0.0.1' });
  assert.equal(r.status, 200);
  const setCookie = r.headers.get('set-cookie');
  assert.match(setCookie, /^__Host-sessao=/);
  assert.match(setCookie, /Secure/);
  const ok = await fetch(base + '/api/painel/sessao', { headers: { Cookie: setCookie.split(';')[0] } });
  assert.equal((await ok.json()).logado, true);
});

test('trocar a senha derruba as sessões abertas', () => {
  const antiga = criarSessoes({ senha: 'senha-1', segredo: 's' });
  const nova = criarSessoes({ senha: 'senha-2', segredo: 's' });
  const token = antiga.emitir();
  assert.equal(antiga.valida(token), true);
  assert.equal(nova.valida(token), false);
});

test('True-Client-IP falso não escapa do limite de senha', async () => {
  let ultimo;
  for (let i = 0; i < 11; i++) {
    ultimo = await entrar('errada', { 'X-Forwarded-For': '10.0.0.2', 'True-Client-IP': `1.1.1.${i}` });
  }
  assert.equal(ultimo.status, 429);
});

test('teto geral de tentativas de senha vale mesmo trocando de IP', async () => {
  let ultimo;
  for (let i = 0; i < 60; i++) ultimo = await entrar('errada', { 'X-Forwarded-For': `20.0.${i}.1` });
  assert.equal(ultimo.status, 429);
});

test('robots.txt esconde o painel do Google e aponta o sitemap', async () => {
  const robots = await fetch(base + '/robots.txt');
  assert.equal(robots.status, 200);
  const texto = await robots.text();
  assert.match(texto, /Disallow: \/painel/);
  assert.match(texto, /Sitemap: https:\/\//);
  const mapa = await fetch(base + '/sitemap.xml');
  assert.match(mapa.headers.get('content-type'), /application\/xml/);
});
