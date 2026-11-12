// Armazenamento: Postgres (DATABASE_URL) em produção e memória em testes/dev.
// As duas versões têm a mesma interface.
import { randomUUID } from 'node:crypto';

const MIGRACAO = `
CREATE TABLE IF NOT EXISTS pedidos (
  id uuid PRIMARY KEY,
  dia date NOT NULL,
  numero integer NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  situacao text NOT NULL DEFAULT 'novo',
  dados jsonb NOT NULL,
  UNIQUE (dia, numero)
);
CREATE INDEX IF NOT EXISTS pedidos_dia ON pedidos (dia);
CREATE TABLE IF NOT EXISTS configuracoes (chave text PRIMARY KEY, valor jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS whatsapp_sessao (chave text PRIMARY KEY, valor text NOT NULL);
CREATE TABLE IF NOT EXISTS relatorios (
  dia date PRIMARY KEY,
  enviado_em timestamptz NOT NULL DEFAULT now(),
  texto text NOT NULL
);
-- Sem políticas: só o dono das tabelas (o próprio sistema) lê e grava. Fecha o acesso
-- por APIs automáticas do provedor (ex.: a Data API do Supabase).
ALTER TABLE pedidos ENABLE ROW LEVEL SECURITY;
ALTER TABLE configuracoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_sessao ENABLE ROW LEVEL SECURITY;
ALTER TABLE relatorios ENABLE ROW LEVEL SECURITY;
`;

// Número fixo da trava que garante uma única conexão com o WhatsApp.
const TRAVA_WHATSAPP = 7311001;

const montar = (linha) => ({
  ...linha.dados,
  id: linha.id,
  dia: linha.dia,
  numero: linha.numero,
  criadoEm: new Date(linha.criado_em).toISOString(),
  situacao: linha.situacao,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function criarBancoMemoria() {
  const pedidos = [];
  const config = new Map();
  const sessao = new Map();
  const relatorios = new Map();
  const ordenar = (a, b) => (a.dia === b.dia ? a.numero - b.numero : a.dia < b.dia ? -1 : 1);
  return {
    tipo: 'memoria',
    async iniciar() {},
    async fechar() {},
    criarTrava() {
      return { async tentar() { return true; }, aoPerder() {}, async liberar() {} };
    },
    async criarPedido(dados, dia, agora = new Date()) {
      const numero = Math.max(0, ...pedidos.filter((p) => p.dia === dia).map((p) => p.numero)) + 1;
      const pedido = { ...dados, id: randomUUID(), dia, numero, criadoEm: agora.toISOString(), situacao: 'novo' };
      pedidos.push(pedido);
      return structuredClone(pedido);
    },
    async listarPedidos(dia) {
      return structuredClone(pedidos.filter((p) => p.dia === dia).sort(ordenar));
    },
    async listarPedidosPeriodo(de, ate) {
      return structuredClone(pedidos.filter((p) => p.dia >= de && p.dia <= ate).sort(ordenar));
    },
    async mudarSituacao(id, situacao) {
      const p = pedidos.find((x) => x.id === id);
      if (!p) return null;
      p.situacao = situacao;
      return structuredClone(p);
    },
    async apagarCancelado(id) {
      const i = pedidos.findIndex((x) => x.id === id && x.situacao === 'cancelado');
      if (i < 0) return null;
      return pedidos.splice(i, 1)[0];
    },
    async ler(chave) {
      return config.has(chave) ? structuredClone(config.get(chave)) : null;
    },
    async gravar(chave, valor) {
      config.set(chave, structuredClone(valor));
    },
    async lerSessao(chave) {
      return sessao.get(chave) ?? null;
    },
    async gravarSessao(chave, valor) {
      if (valor === null) sessao.delete(chave);
      else sessao.set(chave, valor);
    },
    async limparSessao() {
      sessao.clear();
    },
    async relatorioEnviado(dia) {
      return relatorios.get(dia) ?? null;
    },
    async registrarRelatorio(dia, texto) {
      if (relatorios.has(dia)) return false;
      relatorios.set(dia, { dia, texto, enviadoEm: new Date().toISOString() });
      return true;
    },
  };
}

export async function criarBancoPostgres(url, { log = console } = {}) {
  const { default: pg } = await import('pg');
  pg.types.setTypeParser(1082, (v) => v); // date como texto, sem fuso
  const local = /localhost|127\.0\.0\.1/.test(url);
  const ssl = local ? false : { rejectUnauthorized: false };
  const pool = new pg.Pool({ connectionString: url, ssl, max: 5, idleTimeoutMillis: 30_000, keepAlive: true });
  // Sem este ouvinte, uma conexão ociosa derrubada pelo banco encerraria o processo.
  pool.on('error', (erro) => log.error?.('Banco (conexão ociosa):', erro.message));

  return {
    tipo: 'postgres',
    async iniciar() {
      await pool.query(MIGRACAO);
    },

    // Copia os dados de outro banco (troca de provedor). Pode rodar mais de uma vez:
    // o que já existe aqui é mantido e um pedido cujo número do dia já foi usado
    // entra com o próximo número livre.
    async copiarDe(urlAntiga) {
      const antigo = new pg.Client({
        connectionString: urlAntiga,
        ssl: /localhost|127\.0\.0\.1/.test(urlAntiga) ? false : { rejectUnauthorized: false },
        connectionTimeoutMillis: 15_000,
      });
      antigo.on('error', () => {});
      await antigo.connect();
      try {
        const copiados = { pedidos: 0, configuracoes: 0, whatsapp_sessao: 0, relatorios: 0 };
        const pedidos = await antigo.query('SELECT * FROM pedidos ORDER BY dia, numero');
        for (const p of pedidos.rows) {
          const r = await pool.query(
            `INSERT INTO pedidos (id, dia, numero, criado_em, situacao, dados)
             SELECT $1, $2,
                    CASE WHEN EXISTS (SELECT 1 FROM pedidos WHERE dia = $2 AND numero = $3)
                         THEN (SELECT MAX(numero) + 1 FROM pedidos WHERE dia = $2) ELSE $3 END,
                    $4, $5, $6
             WHERE NOT EXISTS (SELECT 1 FROM pedidos WHERE id = $1)`,
            [p.id, p.dia, p.numero, p.criado_em, p.situacao, p.dados],
          );
          copiados.pedidos += r.rowCount;
        }
        const tabelas = [
          ['configuracoes', 'SELECT chave, valor FROM configuracoes', 'INSERT INTO configuracoes (chave, valor) VALUES ($1, $2)', (l) => [l.chave, JSON.stringify(l.valor)]],
          ['whatsapp_sessao', 'SELECT chave, valor FROM whatsapp_sessao', 'INSERT INTO whatsapp_sessao (chave, valor) VALUES ($1, $2)', (l) => [l.chave, l.valor]],
          ['relatorios', 'SELECT dia, enviado_em, texto FROM relatorios', 'INSERT INTO relatorios (dia, enviado_em, texto) VALUES ($1, $2, $3)', (l) => [l.dia, l.enviado_em, l.texto]],
        ];
        for (const [tabela, consulta, insercao, valores] of tabelas) {
          const { rows } = await antigo.query(consulta);
          for (const linha of rows) {
            const r = await pool.query(`${insercao} ON CONFLICT DO NOTHING`, valores(linha));
            copiados[tabela] += r.rowCount;
          }
        }
        return { ...copiados, pedidosNoBancoAntigo: pedidos.rowCount };
      } finally {
        await antigo.end().catch(() => {});
      }
    },
    async fechar() {
      await pool.end().catch(() => {});
    },

    // Trava de sessão do Postgres: só quem a detém conecta o WhatsApp.
    // Ela some sozinha se o processo morrer ou a conexão cair.
    criarTrava() {
      let cliente = null;
      let pulso = null;
      let aoPerder = () => {};
      const soltar = (c) => {
        if (cliente !== c) return;
        cliente = null;
        clearInterval(pulso);
        c.end().catch(() => {});
        aoPerder();
      };
      return {
        async tentar() {
          if (cliente) return true;
          const c = new pg.Client({ connectionString: url, ssl, keepAlive: true });
          c.on('error', () => soltar(c));
          await c.connect();
          const { rows } = await c.query('SELECT pg_try_advisory_lock($1) AS ok', [TRAVA_WHATSAPP]);
          if (!rows[0].ok) {
            await c.end().catch(() => {});
            return false;
          }
          cliente = c;
          c.on('end', () => soltar(c));
          pulso = setInterval(() => c.query('SELECT 1').catch(() => soltar(c)), 60_000);
          return true;
        },
        aoPerder(fn) {
          aoPerder = fn;
        },
        async liberar() {
          const c = cliente;
          if (!c) return;
          cliente = null;
          clearInterval(pulso);
          await c.end().catch(() => {});
        },
      };
    },

    async criarPedido(dados, dia, agora = new Date()) {
      for (let tentativa = 0; tentativa < 5; tentativa++) {
        try {
          const { rows } = await pool.query(
            `INSERT INTO pedidos (id, dia, numero, criado_em, dados)
             SELECT $1, $2, COALESCE(MAX(numero), 0) + 1, $3, $4 FROM pedidos WHERE dia = $2
             RETURNING *`,
            [randomUUID(), dia, agora, dados],
          );
          return montar(rows[0]);
        } catch (erro) {
          if (erro.code !== '23505') throw erro; // número repetido por pedidos simultâneos
        }
      }
      throw new Error('Não foi possível numerar o pedido.');
    },
    async listarPedidos(dia) {
      const { rows } = await pool.query('SELECT * FROM pedidos WHERE dia = $1 ORDER BY numero', [dia]);
      return rows.map(montar);
    },
    async listarPedidosPeriodo(de, ate) {
      const { rows } = await pool.query('SELECT * FROM pedidos WHERE dia BETWEEN $1 AND $2 ORDER BY dia, numero', [de, ate]);
      return rows.map(montar);
    },
    async mudarSituacao(id, situacao) {
      if (!UUID.test(id)) return null;
      const { rows } = await pool.query('UPDATE pedidos SET situacao = $2 WHERE id = $1 RETURNING *', [id, situacao]);
      return rows[0] ? montar(rows[0]) : null;
    },
    async apagarCancelado(id) {
      if (!UUID.test(id)) return null;
      const { rows } = await pool.query("DELETE FROM pedidos WHERE id = $1 AND situacao = 'cancelado' RETURNING *", [id]);
      return rows[0] ? montar(rows[0]) : null;
    },
    async ler(chave) {
      const { rows } = await pool.query('SELECT valor FROM configuracoes WHERE chave = $1', [chave]);
      return rows[0]?.valor ?? null;
    },
    async gravar(chave, valor) {
      await pool.query(
        'INSERT INTO configuracoes (chave, valor) VALUES ($1, $2) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor',
        [chave, JSON.stringify(valor)],
      );
    },
    async lerSessao(chave) {
      const { rows } = await pool.query('SELECT valor FROM whatsapp_sessao WHERE chave = $1', [chave]);
      return rows[0]?.valor ?? null;
    },
    async gravarSessao(chave, valor) {
      if (valor === null) await pool.query('DELETE FROM whatsapp_sessao WHERE chave = $1', [chave]);
      else {
        await pool.query(
          'INSERT INTO whatsapp_sessao (chave, valor) VALUES ($1, $2) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor',
          [chave, valor],
        );
      }
    },
    async limparSessao() {
      await pool.query('DELETE FROM whatsapp_sessao');
    },
    async relatorioEnviado(dia) {
      const { rows } = await pool.query('SELECT dia, texto, enviado_em FROM relatorios WHERE dia = $1', [dia]);
      return rows[0] ? { dia: rows[0].dia, texto: rows[0].texto, enviadoEm: rows[0].enviado_em.toISOString() } : null;
    },
    async registrarRelatorio(dia, texto) {
      const { rowCount } = await pool.query(
        'INSERT INTO relatorios (dia, texto) VALUES ($1, $2) ON CONFLICT (dia) DO NOTHING',
        [dia, texto],
      );
      return rowCount === 1;
    },
  };
}
