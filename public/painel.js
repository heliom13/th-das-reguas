const $ = (id) => document.getElementById(id);
const reais = (v) => 'R$ ' + Number(v).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const dataBr = (dia) => dia.split('-').reverse().join('/');
const hora = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { timeZone: 'America/Fortaleza', hour: '2-digit', minute: '2-digit' });
const telefoneBr = (t) => t.replace(/^(\d{2})(\d{4,5})(\d{4})$/, '($1) $2-$3');

const estado = { dia: null, hoje: null, dados: null, filtro: 'todos', vistos: new Set(), primeiraCarga: true, eventos: null };

let tt;
function toast(texto) {
  const el = $('toast');
  el.textContent = texto;
  el.hidden = false;
  clearTimeout(tt);
  tt = setTimeout(() => (el.hidden = true), 2600);
}

async function api(caminho, opcoes = {}) {
  const r = await fetch(caminho, {
    ...opcoes,
    headers: opcoes.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opcoes.body ? JSON.stringify(opcoes.body) : undefined,
  });
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
    iniciar();
  });
});

$('sair').addEventListener('click', async () => {
  await api('/api/painel/sair', { method: 'POST', body: {} }).catch(() => {});
  mostrarLogin();
});

// ---------- Pedidos e resumo ----------

function desenharKpis(r, nomes) {
  const pag = Object.entries(nomes.pagamentos)
    .map(([k, n]) => `${n} ${r.porPagamento[k].pedidos}`)
    .join(' · ');
  const produtos = Object.entries(r.porProduto).map(([n, q]) => `${q}x ${n}`).join(' · ') || 'nenhuma peça';
  const kpis = [
    ['Clientes', r.clientes, `${r.pedidos} pedido(s)`, true],
    ['Toucas', r.itens, produtos],
    ['Total do dia', reais(r.valor), pag],
    ['Retirada na loja', r.porRetirada.loja, ''],
    ['Entrega', r.porRetirada.entrega, r.cancelados ? `${r.cancelados} cancelado(s) fora da conta` : ''],
  ];
  $('kpis').replaceChildren(
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
  link.href = `https://wa.me/55${p.telefone.replace(/^55/, '')}`;
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
      if (s === 'cancelado' && !confirm(`Cancelar o pedido #${p.numero} de ${p.nome}?`)) return;
      comBotao(b, async () => {
        await api('/api/painel/situacao', { method: 'POST', body: { id: p.id, situacao: s } });
        await carregar();
      });
    });
    grupo.append(b);
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
    vazio.textContent = pedidos.length ? 'Nenhum pedido neste filtro.' : 'Nenhum pedido neste dia ainda. Os novos aparecem aqui sozinhos.';
    $('pedidos').replaceChildren(vazio);
  } else {
    $('pedidos').replaceChildren(...lista.map((p) => cartaoDoPedido(p, nomes)));
  }
  pedidos.forEach((p) => estado.vistos.add(p.id));
  estado.primeiraCarga = false;
}

function desenharRelatorio() {
  const { texto, relatorio, dia, hoje } = estado.dados;
  $('rel-texto').textContent = texto;
  $('rel-status').textContent = relatorio
    ? `Enviado automaticamente no grupo às ${hora(relatorio.enviadoEm)}.`
    : dia === hoje
      ? 'Ainda não enviado hoje. Prévia do que vai no grupo:'
      : 'Relatório deste dia:';
}

async function carregar() {
  const dados = await api(`/api/painel/pedidos?dia=${estado.dia ?? ''}`);
  const chegouNovo = !estado.primeiraCarga && dados.dia === estado.dados?.dia && dados.pedidos.some((p) => !estado.vistos.has(p.id));
  estado.dados = dados;
  estado.hoje = dados.hoje;
  estado.dia = dados.dia;
  $('dia').value = dados.dia;
  $('dia').max = dados.hoje;
  $('t-dia').textContent = dados.dia === dados.hoje ? `de hoje · ${dataBr(dados.dia)}` : dataBr(dados.dia);
  desenharKpis(dados.resumo, dados.nomes);
  desenharPedidos();
  desenharRelatorio();
  if (chegouNovo) {
    toast('Novo pedido!');
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

$('dia').addEventListener('change', (e) => {
  if (!e.target.value) return;
  estado.dia = e.target.value;
  estado.primeiraCarga = true;
  carregar().catch((err) => toast(err.message));
});

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
    toast('Texto selecionado: use Ctrl+C.');
  }
});

$('rel-enviar').addEventListener('click', (e) =>
  comBotao(e.currentTarget, async () => {
    if (!confirm(`Enviar agora o relatório de ${dataBr(estado.dia)} no grupo?`)) return;
    await api('/api/painel/relatorio/enviar', { method: 'POST', body: { dia: estado.dia } });
    toast('Relatório enviado no grupo.');
  }),
);

// ---------- WhatsApp ----------

const NOMES_ESTADO = {
  conectado: 'Conectado',
  'aguardando-qr': 'Aguardando leitura do QR Code',
  conectando: 'Conectando…',
  desligado: 'Desconectado',
};

function desenharWhatsapp(w) {
  const el = $('wa-estado');
  el.className = 'estado ' + w.estado;
  el.textContent = NOMES_ESTADO[w.estado] + (w.estado === 'conectado' && w.numero ? ` · ${telefoneBr(w.numero.replace(/^55/, ''))}` : '');
  $('wa-erro').textContent = w.erro ?? '';
  $('wa-erro').hidden = !w.erro;
  $('wa-qr').hidden = !w.qr;
  if (w.qr) $('wa-qr').querySelector('img').src = w.qr;
  $('wa-conectar').hidden = w.estado !== 'desligado';
  $('wa-desconectar').hidden = w.estado === 'desligado';
  $('wa-desconectar').textContent = w.estado === 'aguardando-qr' ? 'Cancelar' : 'Desconectar';

  if ('destino' in w) {
    $('wa-grupo').hidden = w.estado !== 'conectado';
    $('grupo-atual').textContent = w.destino?.grupoJid
      ? `Grupo atual: "${w.destino.grupoNome}" com ${telefoneBr(w.destino.numeroDono)}. Criar de novo substitui o grupo.`
      : 'Ainda não há grupo. Informe o número do dono para criar.';
    if (!$('wa-grupo').telefone.value && w.destino?.numeroDono) $('wa-grupo').telefone.value = telefoneBr(w.destino.numeroDono);
    const cfg = $('rel-config');
    if (document.activeElement?.form !== cfg) {
      cfg.ativo.checked = w.relatorio.ativo;
      cfg.horario.value = w.relatorio.horario;
    }
    const avisos = [];
    if (w.pendencia) avisos.push(w.pendencia);
    else if (w.estado === 'desligado') avisos.push('O WhatsApp do robô está desconectado: o relatório automático não será enviado.');
    else if (w.estado === 'conectado' && !w.destino?.grupoJid) avisos.push('Falta criar o grupo do relatório (lado direito).');
    $('aviso').textContent = avisos.join(' ');
    $('aviso').hidden = !avisos.length;
  } else {
    $('wa-grupo').hidden = w.estado !== 'conectado';
  }
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

$('wa-desconectar').addEventListener('click', (e) =>
  comBotao(e.currentTarget, async () => {
    if (e.currentTarget.textContent === 'Desconectar' && !confirm('Desconectar o WhatsApp do robô? O relatório automático para até conectar de novo.')) return;
    await api('/api/painel/whatsapp/desconectar', { method: 'POST', body: {} });
    await carregarWhatsapp();
  }),
);

$('wa-grupo').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  comBotao(form.querySelector('button'), async () => {
    await api('/api/painel/whatsapp/grupo', { method: 'POST', body: { telefone: form.telefone.value } });
    toast('Grupo criado! Confira no WhatsApp do dono.');
    await carregarWhatsapp();
  });
});

$('rel-config').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  comBotao(form.querySelector('button'), async () => {
    await api('/api/painel/relatorio', { method: 'POST', body: { horario: form.horario.value, ativo: form.ativo.checked } });
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
    if (dia === estado.dia) carregar().catch(() => {});
  });
  es.addEventListener('whatsapp', () => carregarWhatsapp().catch(() => {}));
}

// Se o servidor reiniciou ou a aba ficou parada, recarrega ao voltar.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !$('app').hidden) {
    carregar().catch(() => {});
    carregarWhatsapp().catch(() => {});
  }
});

async function iniciar() {
  $('login').hidden = true;
  $('app').hidden = false;
  estado.primeiraCarga = true;
  await Promise.all([carregar(), carregarWhatsapp()]).catch((e) => toast(e.message));
  ouvir();
}

api('/api/painel/sessao')
  .then((s) => {
    if (s.logado) iniciar();
    else {
      mostrarLogin();
      if (!s.habilitado) {
        $('login-erro').textContent = 'Painel sem senha configurada no servidor (PAINEL_SENHA).';
        $('login-erro').hidden = false;
      }
    }
  })
  .catch(() => mostrarLogin());
