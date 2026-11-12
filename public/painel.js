const $ = (id) => document.getElementById(id);
const reais = (v) => 'R$ ' + Number(v).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const reaisCurto = (v) => 'R$ ' + Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const dataBr = (dia) => dia.split('-').reverse().join('/');
const dataCurta = (dia) => dia.slice(8, 10) + '/' + dia.slice(5, 7);
const hora = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { timeZone: 'America/Fortaleza', hour: '2-digit', minute: '2-digit' });
const telefoneBr = (t) => String(t).replace(/^55(?=\d{10,11}$)/, '').replace(/^(\d{2})(\d{4,5})(\d{4})$/, '($1) $2-$3');
const somarDias = (dia, n) => {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

const estado = {
  aba: 'pedidos', dia: null, hoje: null, dados: null, filtro: 'todos', vistos: new Set(), primeiraCarga: true,
  eventos: null, periodo: { preset: 'mes', de: null, ate: null }, dadosPeriodo: null, catalogo: null, whatsapp: null,
};

// ---------- Utilidades ----------

let tt;
function toast(texto) {
  const el = $('toast');
  el.textContent = texto;
  el.hidden = false;
  clearTimeout(tt);
  tt = setTimeout(() => (el.hidden = true), 2800);
}

async function api(caminho, opcoes = {}) {
  let r;
  try {
    r = await fetch(caminho, {
      method: opcoes.method,
      headers: opcoes.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opcoes.body ? JSON.stringify(opcoes.body) : undefined,
    });
  } catch {
    throw new Error('Sem conexão com o servidor. Confira a internet.');
  }
  const corpo = await r.json().catch(() => ({}));
  if (r.status === 401 && !caminho.endsWith('/entrar')) {
    mostrarLogin();
    throw new Error(corpo.erro || 'Entre de novo.');
  }
  if (!r.ok) throw new Error(corpo.erro || 'Algo deu errado. Tente de novo.');
  return corpo;
}

// Executa a ação com o botão bloqueado, evitando clique duplo.
async function comBotao(botao, acao) {
  if (botao.disabled) return;
  botao.disabled = true;
  try {
    await acao();
  } catch (e) {
    toast(e.message);
  } finally {
    botao.disabled = false;
  }
}

const guardar = (k, v) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    // sem armazenamento local: segue sem lembrar
  }
};
const lembrar = (k) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};

// Som curto de pedido novo (o navegador só libera áudio depois de um toque na página).
let audio = null;
document.addEventListener('pointerdown', () => {
  try {
    audio ??= new AudioContext();
    audio.resume?.();
  } catch {
    audio = null;
  }
});
function bip() {
  if (!audio) return;
  const t = audio.currentTime;
  for (const [ini, freq] of [[0, 880], [0.18, 1175]]) {
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t + ini);
    g.gain.exponentialRampToValueAtTime(0.25, t + ini + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + ini + 0.16);
    o.connect(g).connect(audio.destination);
    o.start(t + ini);
    o.stop(t + ini + 0.17);
  }
}

// ---------- Login ----------

function mostrarLogin() {
  estado.eventos?.close();
  $('app').hidden = true;
  $('login').hidden = false;
  $('login-form').senha.focus();
}

$('login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  comBotao(form.querySelector('button'), async () => {
    $('login-erro').hidden = true;
    try {
      await api('/api/painel/entrar', { method: 'POST', body: { senha: form.senha.value } });
    } catch (err) {
      $('login-erro').textContent = err.message;
      $('login-erro').hidden = false;
      return;
    }
    form.reset();
    await iniciar();
  });
});

$('sair').addEventListener('click', async () => {
  await api('/api/painel/sair', { method: 'POST', body: {} }).catch(() => {});
  mostrarLogin();
});

// ---------- Abas ----------

const ABAS = ['pedidos', 'relatorios', 'produtos', 'whatsapp'];

function mostrarAba(nome, { foco = false } = {}) {
  if (!ABAS.includes(nome)) nome = 'pedidos';
  estado.aba = nome;
  guardar('painel-aba', nome);
  for (const a of ABAS) {
    const botao = $(`aba-${a}`);
    const ativa = a === nome;
    botao.setAttribute('aria-selected', String(ativa));
    botao.tabIndex = ativa ? 0 : -1;
    $(`sec-${a}`).hidden = !ativa;
    if (ativa && foco) botao.focus();
  }
  if (nome === 'relatorios') carregarPeriodo().catch((e) => toast(e.message));
  if (nome === 'produtos' && !estado.catalogo) carregarCatalogo().catch((e) => toast(e.message));
  if (nome === 'whatsapp') carregarWhatsapp().catch((e) => toast(e.message));
  window.scrollTo({ top: 0 });
}

document.querySelectorAll('[role=tab]').forEach((b) => {
  b.addEventListener('click', () => mostrarAba(b.dataset.aba));
  b.addEventListener('keydown', (e) => {
    const i = ABAS.indexOf(b.dataset.aba);
    if (e.key === 'ArrowRight') mostrarAba(ABAS[(i + 1) % ABAS.length], { foco: true });
    if (e.key === 'ArrowLeft') mostrarAba(ABAS[(i + ABAS.length - 1) % ABAS.length], { foco: true });
  });
});

// ---------- Indicadores ----------

function desenharKpis(alvo, kpis) {
  alvo.replaceChildren(
    ...kpis.map(([rotulo, valor, detalhe, destaque]) => {
      const el = document.createElement('div');
      el.className = 'kpi' + (destaque ? ' destaque' : '');
      el.innerHTML = `<b></b><span></span>${detalhe ? '<small></small>' : ''}`;
      el.querySelector('b').textContent = valor;
      el.querySelector('span').textContent = rotulo;
      if (detalhe) el.querySelector('small').textContent = detalhe;
      return el;
    }),
  );
}

const textoPagamentos = (r, nomes) =>
  Object.entries(nomes.pagamentos).map(([k, n]) => `${n} ${r.porPagamento[k].pedidos}`).join(' · ');

// ---------- Pedidos do dia ----------

function cartaoDoPedido(p, nomes) {
  const el = document.createElement('article');
  el.className = 'pedido' + (p.situacao === 'cancelado' ? ' cancelado' : '');
  if (!estado.primeiraCarga && !estado.vistos.has(p.id)) el.classList.add('novo-agora');
  el.innerHTML = `
    <div class="p-topo"><div><span class="num"></span><span class="nome"></span></div><span class="hora"></span></div>
    <div class="tags"><span class="tag qtd"></span><span class="tag pag"></span><span class="tag ret"></span></div>
    <p class="p-info tel"></p>
    <div class="p-pe"><span class="total"></span><div class="situacoes" role="group" aria-label="Situação do pedido"></div></div>`;
  el.querySelector('.num').textContent = '#' + p.numero;
  el.querySelector('.nome').textContent = p.nome;
  el.querySelector('.hora').textContent = hora(p.criadoEm);
  el.querySelector('.qtd').textContent = `${p.quantidade}x ${p.produtoNome}`;
  let pag = nomes.pagamentos[p.pagamento];
  if (p.pagamento === 'dinheiro' && p.troco) pag += ` · troco p/ ${reais(p.troco)}`;
  el.querySelector('.pag').textContent = pag;
  const ret = el.querySelector('.ret');
  ret.textContent = nomes.retiradas[p.retirada];
  if (p.retirada === 'entrega') ret.classList.add('entrega');

  const info = el.querySelector('.tel');
  const link = document.createElement('a');
  link.href = `https://wa.me/55${String(p.telefone).replace(/^55(?=\d{10,11}$)/, '')}`;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = telefoneBr(p.telefone);
  info.append('📱 ', link);
  if (p.retirada === 'entrega') {
    const end = document.createElement('p');
    end.className = 'p-info';
    end.textContent = '📍 ' + p.endereco;
    info.after(end);
  }
  el.querySelector('.total').textContent = reais(p.total);

  const grupo = el.querySelector('.situacoes');
  for (const [s, nome] of Object.entries(nomes.situacoes)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.s = s;
    b.textContent = nome;
    b.setAttribute('aria-pressed', String(p.situacao === s));
    b.addEventListener('click', () => {
      if (p.situacao === s) return;
      if (s === 'cancelado' && !confirm(`Cancelar o pedido #${p.numero} de ${p.nome}? Ele sai das contas do dia.`)) return;
      comBotao(b, async () => {
        await api('/api/painel/situacao', { method: 'POST', body: { id: p.id, situacao: s } });
        await carregarPedidos();
      });
    });
    grupo.append(b);
  }
  if (p.situacao === 'cancelado') {
    const apagar = document.createElement('button');
    apagar.type = 'button';
    apagar.className = 'apagar';
    apagar.textContent = 'Apagar';
    apagar.addEventListener('click', () => {
      if (!confirm(`Apagar de vez o pedido #${p.numero} de ${p.nome}? Use para pedidos de teste ou falsos.`)) return;
      comBotao(apagar, async () => {
        await api('/api/painel/apagar', { method: 'POST', body: { id: p.id } });
        await carregarPedidos();
      });
    });
    grupo.append(apagar);
  }
  return el;
}

function desenharPedidos() {
  const { pedidos, nomes } = estado.dados;
  const lista = pedidos
    .filter((p) => estado.filtro === 'todos' || p.retirada === estado.filtro)
    .sort((a, b) => b.numero - a.numero);
  if (!lista.length) {
    const vazio = document.createElement('p');
    vazio.className = 'vazio';
    vazio.textContent = pedidos.length
      ? 'Nenhum pedido neste filtro.'
      : estado.dia === estado.hoje
        ? 'Nenhum pedido hoje ainda. Os novos aparecem aqui sozinhos.'
        : 'Nenhum pedido neste dia.';
    $('pedidos').replaceChildren(vazio);
  } else {
    $('pedidos').replaceChildren(...lista.map((p) => cartaoDoPedido(p, nomes)));
  }
  pedidos.forEach((p) => estado.vistos.add(p.id));
  estado.primeiraCarga = false;
}

function desenharRelatorioDoDia() {
  const { texto, relatorio, dia, hoje } = estado.dados;
  $('rel-texto').textContent = texto;
  $('rel-status').textContent = relatorio
    ? `Enviado automaticamente no grupo às ${hora(relatorio.enviadoEm)}.`
    : dia === hoje
      ? 'Ainda não enviado hoje. Prévia do que vai no grupo:'
      : 'Relatório deste dia:';
}

async function carregarPedidos() {
  const dados = await api(`/api/painel/pedidos?dia=${estado.dia ?? ''}`);
  const mesmoDia = dados.dia === estado.dados?.dia;
  const chegouNovo = !estado.primeiraCarga && mesmoDia && dados.pedidos.some((p) => !estado.vistos.has(p.id));
  estado.dados = dados;
  estado.hoje = dados.hoje;
  estado.dia = dados.dia;
  $('dia').value = dados.dia;
  $('dia').max = dados.hoje;
  $('dia-prox').disabled = dados.dia >= dados.hoje;
  $('t-dia').textContent = dados.dia === dados.hoje ? `de hoje · ${dataBr(dados.dia)}` : dataBr(dados.dia);
  const r = dados.resumo;
  const produtos = Object.entries(r.porProduto).map(([n, q]) => `${q}x ${n}`).join(' · ') || 'nenhuma';
  desenharKpis($('kpis'), [
    ['Clientes', r.clientes, `${r.pedidos} pedido(s)`, true],
    ['Toucas', r.itens, produtos],
    ['Total do dia', reais(r.valor), textoPagamentos(r, dados.nomes)],
    ['Retirada na loja', r.porRetirada.loja, ''],
    ['Entrega', r.porRetirada.entrega, r.cancelados ? `${r.cancelados} cancelado(s) fora da conta` : ''],
  ]);
  desenharPedidos();
  desenharRelatorioDoDia();
  if (chegouNovo) {
    toast('Novo pedido!');
    bip();
    piscarTitulo();
  }
}

let piscando;
function piscarTitulo() {
  clearInterval(piscando);
  let n = 0;
  piscando = setInterval(() => {
    document.title = n++ % 2 ? 'Painel de pedidos' : '🔔 Novo pedido!';
    if (n > 10 || !document.hidden) {
      clearInterval(piscando);
      document.title = 'Painel de pedidos';
    }
  }, 1000);
}

function irParaDia(dia) {
  if (!dia || dia > estado.hoje) return;
  estado.dia = dia;
  estado.primeiraCarga = true;
  carregarPedidos().catch((err) => toast(err.message));
}
$('dia').addEventListener('change', (e) => irParaDia(e.target.value));
$('dia-ant').addEventListener('click', () => irParaDia(somarDias(estado.dia, -1)));
$('dia-prox').addEventListener('click', () => irParaDia(somarDias(estado.dia, 1)));

document.querySelectorAll('[data-filtro]').forEach((b) =>
  b.addEventListener('click', () => {
    estado.filtro = b.dataset.filtro;
    document.querySelectorAll('[data-filtro]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    desenharPedidos();
  }),
);

$('rel-copiar').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(estado.dados.texto);
    toast('Relatório copiado. É só colar no WhatsApp.');
  } catch {
    const r = document.createRange();
    r.selectNodeContents($('rel-texto'));
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    toast('Texto selecionado: use Copiar do celular ou Ctrl+C.');
  }
});

$('rel-enviar').addEventListener('click', (e) => {
  const botao = e.currentTarget;
  if (!confirm(`Enviar agora o relatório de ${dataBr(estado.dia)} no grupo?`)) return;
  comBotao(botao, async () => {
    await api('/api/painel/relatorio/enviar', { method: 'POST', body: { dia: estado.dia } });
    toast('Relatório enviado no grupo.');
  });
});

// ---------- Relatórios por período ----------

function calcularPeriodo(preset, hoje) {
  if (preset === '7') return { de: somarDias(hoje, -6), ate: hoje };
  if (preset === '30') return { de: somarDias(hoje, -29), ate: hoje };
  if (preset === 'mes-ant') {
    const inicioMes = hoje.slice(0, 8) + '01';
    const fim = somarDias(inicioMes, -1);
    return { de: fim.slice(0, 8) + '01', ate: fim };
  }
  return { de: hoje.slice(0, 8) + '01', ate: hoje };
}

async function carregarPeriodo() {
  const hoje = estado.hoje ?? new Date().toISOString().slice(0, 10);
  const p = estado.periodo;
  if (p.preset) Object.assign(p, calcularPeriodo(p.preset, hoje));
  const form = $('per-form');
  form.de.value = p.de;
  form.ate.value = p.ate;
  form.de.max = form.ate.max = hoje;
  document.querySelectorAll('[data-periodo]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.periodo === p.preset)));
  $('per-csv').href = `/api/painel/exportar?de=${p.de}&ate=${p.ate}`;
  const d = await api(`/api/painel/periodo?de=${p.de}&ate=${p.ate}`);
  estado.dadosPeriodo = d;
  desenharPeriodo(d);
}

function desenharPeriodo(d) {
  const r = d.resumo;
  const dias = d.porDia.length;
  $('per-titulo').textContent = `${dataBr(d.de)} a ${dataBr(d.ate)} · ${dias} dia(s)`;
  desenharKpis($('per-kpis'), [
    ['Clientes', r.clientes, `${r.pedidos} pedido(s)`, true],
    ['Toucas', r.itens, `média de ${(r.itens / dias).toFixed(1).replace('.', ',')} por dia`],
    ['Total vendido', reais(r.valor), textoPagamentos(r, d.nomes)],
    ['Ticket médio', r.pedidos ? reais(r.valor / r.pedidos) : '—', 'por pedido'],
  ]);
  desenharGrafico(d.porDia);

  const max = (lista) => Math.max(1, ...lista.map((i) => i.n));
  const produtos = Object.entries(r.porProduto).map(([rotulo, n]) => ({ rotulo, n, texto: `${n} un.` }));
  listaBarras($('per-produtos'), produtos, max(produtos), 'Nenhuma venda no período.');
  const pag = Object.entries(d.nomes.pagamentos).map(([k, rotulo]) => ({
    rotulo, n: r.porPagamento[k].valor, texto: `${r.porPagamento[k].pedidos} · ${reais(r.porPagamento[k].valor)}`,
  }));
  listaBarras($('per-pag'), pag, max(pag));
  const ret = Object.entries(d.nomes.retiradas).map(([k, rotulo]) => ({ rotulo, n: r.porRetirada[k], texto: `${r.porRetirada[k]} pedido(s)` }));
  listaBarras($('per-ret'), ret, max(ret));

  const corpo = $('per-tabela').tBodies[0];
  corpo.replaceChildren(
    ...[...d.porDia].reverse().map((l) => {
      const tr = document.createElement('tr');
      if (!l.pedidos) tr.className = 'zero';
      [dataBr(l.dia), l.clientes, l.pedidos, l.itens, reais(l.valor)].forEach((v, i) => {
        const td = document.createElement('td');
        td.textContent = v;
        if (i === 1) td.className = 'opcional';
        tr.append(td);
      });
      return tr;
    }),
  );
  const pe = document.createElement('tr');
  ['Total', r.clientes, r.pedidos, r.itens, reais(r.valor)].forEach((v, i) => {
    const td = document.createElement('td');
    td.textContent = v;
    if (i === 1) td.className = 'opcional';
    pe.append(td);
  });
  $('per-tabela').tFoot.replaceChildren(pe);
}

function listaBarras(ul, itens, max, vazio) {
  if (vazio && !itens.length) {
    const li = document.createElement('li');
    li.className = 'sub';
    li.textContent = vazio;
    ul.replaceChildren(li);
    return;
  }
  ul.replaceChildren(
    ...itens.map((i) => {
      const li = document.createElement('li');
      li.innerHTML = '<span class="rotulo"></span><span class="valor"></span><span class="trilho"><i></i></span>';
      li.querySelector('.rotulo').textContent = i.rotulo;
      li.querySelector('.valor').textContent = i.texto;
      li.querySelector('i').style.width = `${(i.n / max) * 100}%`;
      return li;
    }),
  );
}

// Gráfico de barras simples (valor vendido por dia; por mês em períodos longos).
function agruparPorMes(porDia) {
  const meses = new Map();
  for (const l of porDia) {
    const k = l.dia.slice(0, 7);
    const m = meses.get(k) ?? { chave: k, pedidos: 0, itens: 0, valor: 0 };
    m.pedidos += l.pedidos;
    m.itens += l.itens;
    m.valor += l.valor;
    meses.set(k, m);
  }
  return [...meses.values()].map((m) => {
    const rotulo = `${MESES[Number(m.chave.slice(5, 7)) - 1]}/${m.chave.slice(2, 4)}`;
    return { ...m, rotulo, titulo: rotulo };
  });
}

function escalaBonita(max) {
  const passo = 10 ** Math.floor(Math.log10(max));
  for (const f of [1, 2, 2.5, 5, 10]) if (f * passo >= max) return f * passo;
  return 10 * passo;
}

function desenharGrafico(porDia) {
  const caixa = $('grafico');
  const pontos = porDia.length > 62
    ? agruparPorMes(porDia)
    : porDia.map((l) => ({ ...l, rotulo: dataCurta(l.dia), titulo: dataBr(l.dia) }));
  const NS = 'http://www.w3.org/2000/svg';
  const W = Math.max(280, caixa.clientWidth || 600);
  const H = 240;
  const m = { t: 12, r: 8, b: 26, l: 62 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  const total = pontos.reduce((s, p) => s + p.valor, 0);
  svg.setAttribute('aria-label', `Vendas por ${porDia.length > 62 ? 'mês' : 'dia'}: total ${reais(total)}. Veja a tabela dia a dia abaixo.`);
  const el = (tag, attrs, texto) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (texto !== undefined) n.textContent = texto;
    svg.append(n);
    return n;
  };
  const maxValor = Math.max(...pontos.map((p) => p.valor), 0);
  if (!maxValor) {
    el('line', { class: 'base', x1: m.l, x2: W - m.r, y1: m.t + ih, y2: m.t + ih });
    el('text', { class: 'vazio-graf', x: m.l + iw / 2, y: m.t + ih / 2, 'text-anchor': 'middle' }, 'Sem vendas no período');
    caixa.replaceChildren(svg);
    return;
  }
  const topo = escalaBonita(maxValor);
  for (let i = 0; i <= 4; i++) {
    const v = (topo / 4) * i;
    const y = m.t + ih - (v / topo) * ih;
    if (i) el('line', { class: 'grade', x1: m.l, x2: W - m.r, y1: y, y2: y });
    el('text', { class: 'eixo', x: m.l - 8, y: y + 4, 'text-anchor': 'end' }, reaisCurto(v));
  }
  const n = pontos.length;
  const faixa = iw / n;
  const larg = Math.max(2, Math.min(32, faixa * 0.62));
  const cadaRotulo = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(iw / 48))));
  const base = m.t + ih;
  pontos.forEach((p, i) => {
    const x = m.l + i * faixa + (faixa - larg) / 2;
    const alvo = el('rect', { class: 'alvo', x: m.l + i * faixa, y: m.t, width: faixa, height: ih, tabindex: n <= 62 ? 0 : -1 });
    alvo.setAttribute('aria-label', `${p.titulo}: ${p.pedidos} pedido(s), ${p.itens} touca(s), ${reais(p.valor)}`);
    if (p.valor > 0) {
      const h = Math.max(2, (p.valor / topo) * ih);
      const y = base - h;
      const r = Math.min(4, larg / 2, h);
      el('path', {
        class: 'barra',
        d: `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + larg - r}Q${x + larg},${y} ${x + larg},${y + r}V${base}Z`,
      });
    } else {
      el('g', {});
    }
    const mostrar = (ev) => mostrarDica(p, ev, alvo);
    alvo.addEventListener('pointerenter', mostrar);
    alvo.addEventListener('pointermove', mostrar);
    alvo.addEventListener('focus', mostrar);
    alvo.addEventListener('pointerleave', esconderDica);
    alvo.addEventListener('blur', esconderDica);
    if (i % cadaRotulo === 0) el('text', { class: 'eixo', x: m.l + i * faixa + faixa / 2, y: H - 6, 'text-anchor': 'middle' }, p.rotulo);
  });
  el('line', { class: 'base', x1: m.l, x2: W - m.r, y1: base, y2: base });
  caixa.replaceChildren(svg);
}

function mostrarDica(p, ev, alvo) {
  const dica = $('dica');
  dica.innerHTML = '<b></b><br><span></span>';
  dica.querySelector('b').textContent = p.titulo;
  dica.querySelector('span').textContent = `${reais(p.valor)} · ${p.itens} touca(s) · ${p.pedidos} pedido(s)`;
  dica.hidden = false;
  const caixa = alvo.getBoundingClientRect();
  const x = ev?.clientX ?? caixa.left + caixa.width / 2;
  const y = ev?.clientY ?? caixa.top + 40;
  const larg = dica.offsetWidth;
  dica.style.left = `${Math.min(window.innerWidth - larg - 8, Math.max(8, x - larg / 2))}px`;
  dica.style.top = `${Math.max(8, y - dica.offsetHeight - 14)}px`;
}
function esconderDica() {
  $('dica').hidden = true;
}

let redimensionar;
window.addEventListener('resize', () => {
  clearTimeout(redimensionar);
  redimensionar = setTimeout(() => {
    if (estado.aba === 'relatorios' && estado.dadosPeriodo) desenharGrafico(estado.dadosPeriodo.porDia);
  }, 150);
});

document.querySelectorAll('[data-periodo]').forEach((b) =>
  b.addEventListener('click', () => {
    estado.periodo = { preset: b.dataset.periodo, de: null, ate: null };
    carregarPeriodo().catch((e) => toast(e.message));
  }),
);
$('per-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  if (!f.de.value || !f.ate.value) return;
  if (f.de.value > f.ate.value) return toast('A data inicial precisa ser antes da final.');
  estado.periodo = { preset: null, de: f.de.value, ate: f.ate.value };
  comBotao(f.querySelector('button'), carregarPeriodo);
});
$('per-imprimir').addEventListener('click', () => window.print());

// ---------- Produtos ----------

const decimal = (v) => (v === null || v === undefined || v === '' ? '' : Number(v).toFixed(2).replace('.', ','));

function linhaDoProduto(p = { nome: '', detalhe: '', preco: '', precoAntigo: null, ativo: true }) {
  const el = document.createElement('div');
  el.className = 'produto' + (p.ativo ? '' : ' inativo');
  if (p.id) el.dataset.id = p.id;
  el.innerHTML = `
    <div class="produto-topo"><b></b><button type="button" class="btn btn-sm btn-perigo remover">Remover</button></div>
    <label class="field"><span>Nome</span><input name="nome" maxlength="80" required></label>
    <label class="field"><span>Detalhe (opcional)</span><input name="detalhe" maxlength="120" placeholder="Ex.: Touca para reflexo + agulha de brinde"></label>
    <div class="precos">
      <label class="field"><span>Preço (R$)</span><input name="preco" inputmode="decimal" required></label>
      <label class="field"><span>Preço antigo (R$)</span><input name="precoAntigo" inputmode="decimal" placeholder="opcional"></label>
    </div>
    <label class="toggle"><input type="checkbox" name="ativo"> <span>Aparece no site</span></label>`;
  const titulo = el.querySelector('b');
  const nome = el.querySelector('[name=nome]');
  const atualizarTitulo = () => (titulo.textContent = nome.value.trim() || 'Novo produto');
  nome.value = p.nome;
  el.querySelector('[name=detalhe]').value = p.detalhe ?? '';
  el.querySelector('[name=preco]').value = decimal(p.preco);
  el.querySelector('[name=precoAntigo]').value = decimal(p.precoAntigo);
  const ativo = el.querySelector('[name=ativo]');
  ativo.checked = p.ativo !== false;
  ativo.addEventListener('change', () => el.classList.toggle('inativo', !ativo.checked));
  nome.addEventListener('input', atualizarTitulo);
  atualizarTitulo();
  el.querySelector('.remover').addEventListener('click', () => {
    if (!confirm(`Remover "${titulo.textContent}" da lista? Só vale depois de Salvar.`)) return;
    el.remove();
  });
  return el;
}

function desenharCatalogo(c) {
  $('cat-lista').replaceChildren(...c.produtos.map((p) => linhaDoProduto(p)));
  $('cat-form').taxaEntrega.value = decimal(c.taxaEntrega);
  $('cat-erro').hidden = true;
}

async function carregarCatalogo() {
  estado.catalogo = await api('/api/painel/catalogo');
  desenharCatalogo(estado.catalogo);
}

$('cat-novo').addEventListener('click', () => {
  const linha = linhaDoProduto();
  $('cat-lista').append(linha);
  linha.querySelector('[name=nome]').focus();
});

$('cat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const produtos = [...$('cat-lista').querySelectorAll('.produto')].map((el) => ({
    ...(el.dataset.id ? { id: el.dataset.id } : {}),
    nome: el.querySelector('[name=nome]').value,
    detalhe: el.querySelector('[name=detalhe]').value,
    preco: el.querySelector('[name=preco]').value,
    precoAntigo: el.querySelector('[name=precoAntigo]').value || null,
    ativo: el.querySelector('[name=ativo]').checked,
  }));
  comBotao(form.querySelector('[type=submit]'), async () => {
    $('cat-erro').hidden = true;
    try {
      const r = await api('/api/painel/catalogo', { method: 'POST', body: { produtos, taxaEntrega: form.taxaEntrega.value } });
      estado.catalogo = r.catalogo;
      desenharCatalogo(r.catalogo);
      toast('Produtos salvos. O site já mostra os novos dados.');
    } catch (err) {
      $('cat-erro').textContent = err.message;
      $('cat-erro').hidden = false;
    }
  });
});

// ---------- WhatsApp ----------

const NOMES_ESTADO = {
  conectado: 'Conectado',
  'aguardando-qr': 'Aguardando a leitura do QR Code',
  conectando: 'Conectando…',
  desligado: 'Desconectado',
};

function desenharAviso(w) {
  const aviso = $('aviso');
  let texto = '';
  if (w.pendencia) texto = w.pendencia;
  else if (w.relatorio.ativo && w.estado === 'desligado') texto = 'O WhatsApp do robô está desconectado: o relatório automático não será enviado.';
  else if (w.estado === 'conectado' && !w.destino?.grupoJid) texto = 'Falta criar o grupo do relatório com o dono.';
  aviso.replaceChildren();
  aviso.hidden = !texto;
  if (!texto) return;
  aviso.append(texto);
  if (estado.aba !== 'whatsapp') {
    const ir = document.createElement('button');
    ir.type = 'button';
    ir.className = 'btn btn-sm btn-ghost';
    ir.textContent = 'Resolver';
    ir.addEventListener('click', () => mostrarAba('whatsapp'));
    aviso.append(ir);
  }
}

function desenharWhatsapp(w) {
  estado.whatsapp = w;
  const ponto = $('wa-ponto');
  ponto.className = 'ponto ' + (w.estado === 'conectado' && w.destino?.grupoJid ? 'conectado' : w.relatorio.ativo ? 'alerta' : '');
  const el = $('wa-estado');
  el.className = 'estado ' + w.estado;
  el.textContent = NOMES_ESTADO[w.estado] + (w.estado === 'conectado' && w.numero ? ` · ${telefoneBr(w.numero)}` : '');
  $('wa-erro').textContent = w.erro ?? '';
  $('wa-erro').hidden = !w.erro;
  $('wa-qr').hidden = !w.qr;
  if (w.qr) $('wa-qr').querySelector('img').src = w.qr;
  $('wa-explica').hidden = w.estado === 'conectado';
  $('wa-conectar').hidden = w.estado !== 'desligado';
  $('wa-desconectar').hidden = w.estado === 'desligado';
  $('wa-desconectar').textContent = w.estado === 'aguardando-qr' ? 'Cancelar' : 'Desconectar';

  const conectado = w.estado === 'conectado';
  const grupo = $('wa-grupo');
  grupo.querySelectorAll('input, button').forEach((c) => (c.disabled = !conectado));
  $('wa-teste').disabled = !conectado || !w.destino?.grupoJid;
  let sobreGrupo;
  if (!w.destino?.grupoJid) sobreGrupo = conectado ? 'Informe o WhatsApp do dono para criar o grupo.' : 'Conecte o robô primeiro.';
  else {
    sobreGrupo = `Grupo "${w.destino.grupoNome}" com ${telefoneBr(w.destino.numeroDono)}.`;
    if (w.destino.donoNoGrupo === false) sobreGrupo += ' A privacidade do dono não deixou adicioná-lo: o convite foi enviado no WhatsApp dele; é só tocar no link.';
    sobreGrupo += ' Criar de novo faz um grupo novo.';
  }
  $('grupo-atual').textContent = sobreGrupo;
  if (!grupo.telefone.value && w.destino?.numeroDono) grupo.telefone.value = telefoneBr(w.destino.numeroDono);

  const cfg = $('rel-config');
  if (!cfg.contains(document.activeElement)) {
    cfg.ativo.checked = w.relatorio.ativo;
    cfg.horario.value = w.relatorio.horario;
    cfg.avisarPedido.checked = w.relatorio.avisarPedido;
  }
  desenharAviso(w);
}

async function carregarWhatsapp() {
  desenharWhatsapp(await api('/api/painel/whatsapp'));
}

$('wa-conectar').addEventListener('click', (e) =>
  comBotao(e.currentTarget, async () => {
    await api('/api/painel/whatsapp/conectar', { method: 'POST', body: {} });
    await carregarWhatsapp();
  }),
);

$('wa-desconectar').addEventListener('click', (e) => {
  const botao = e.currentTarget;
  if (botao.textContent === 'Desconectar' && !confirm('Desconectar o WhatsApp do robô? O relatório automático para até conectar de novo.')) return;
  comBotao(botao, async () => {
    await api('/api/painel/whatsapp/desconectar', { method: 'POST', body: {} });
    await carregarWhatsapp();
  });
});

$('wa-grupo').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  comBotao(form.querySelector('[type=submit]'), async () => {
    const r = await api('/api/painel/whatsapp/grupo', { method: 'POST', body: { telefone: form.telefone.value } });
    toast(r.grupo.donoNoGrupo ? 'Grupo criado! Confira no WhatsApp do dono.' : 'Grupo criado. O convite foi enviado no WhatsApp do dono.');
    await carregarWhatsapp();
  });
});

$('wa-teste').addEventListener('click', (e) =>
  comBotao(e.currentTarget, async () => {
    await api('/api/painel/whatsapp/teste', { method: 'POST', body: {} });
    toast('Mensagem de teste enviada no grupo.');
  }),
);

$('rel-config').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  comBotao(form.querySelector('[type=submit]'), async () => {
    await api('/api/painel/relatorio', {
      method: 'POST',
      body: { horario: form.horario.value, ativo: form.ativo.checked, avisarPedido: form.avisarPedido.checked },
    });
    toast(form.ativo.checked ? `Relatório automático às ${form.horario.value}.` : 'Envio automático desligado.');
    await carregarWhatsapp();
  });
});

// ---------- Tempo real ----------

function ouvir() {
  estado.eventos?.close();
  const es = new EventSource('/api/painel/eventos');
  estado.eventos = es;
  es.onopen = () => $('ao-vivo').classList.remove('off');
  es.onerror = () => $('ao-vivo').classList.add('off');
  es.addEventListener('pedido', (e) => {
    const { dia } = JSON.parse(e.data);
    if (dia === estado.dia) carregarPedidos().catch(() => {});
    if (estado.aba === 'relatorios') carregarPeriodo().catch(() => {});
  });
  es.addEventListener('whatsapp', () => carregarWhatsapp().catch(() => {}));
}

// Ao voltar para a aba do navegador, atualiza tudo (o celular pode ter suspendido a conexão).
document.addEventListener('visibilitychange', () => {
  if (document.hidden || $('app').hidden) return;
  carregarPedidos().catch(() => {});
  carregarWhatsapp().catch(() => {});
  if (estado.aba === 'relatorios') carregarPeriodo().catch(() => {});
  if (!estado.eventos || estado.eventos.readyState === EventSource.CLOSED) ouvir();
});

async function iniciar() {
  $('login').hidden = true;
  $('app').hidden = false;
  estado.primeiraCarga = true;
  await Promise.all([carregarPedidos(), carregarWhatsapp()]).catch((e) => toast(e.message));
  mostrarAba(lembrar('painel-aba') ?? 'pedidos');
  ouvir();
}

api('/api/painel/sessao')
  .then((s) => {
    if (s.logado) return iniciar();
    mostrarLogin();
    if (!s.habilitado) {
      $('login-erro').textContent = 'Painel sem senha configurada no servidor (PAINEL_SENHA).';
      $('login-erro').hidden = false;
    }
  })
  .catch(() => mostrarLogin());
