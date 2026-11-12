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
`;

const montar = (linha) => ({
  ...linha.dados,
  id: linha.id,
  dia: typeof linha.dia === 'string' ? linha.dia : linha.dia.toISOString().slice(0, 10),
  numero: linha.numero,
  criadoEm: new Date(linha.criado_em).toISOString(),
  situacao: linha.situacao,
});

export function criarBancoMemoria() {
  const pedidos = [];
  const config = new Map();
  const sessao = new Map();
  const relatorios = new Map();
  return {
    tipo: 'memoria',
    async iniciar() {},
    async fechar() {},
    async criarPedido(dados, dia, agora = new Date()) {
      const numero = pedidos.filter((p) => p.dia === dia).length + 1;
      const pedido = { ...dados, id: randomUUID(), dia, numero, criadoEm: agora.toISOString(), situacao: 'novo' };
      pedidos.push(pedido);
      return structuredClone(pedido);
    },
    async listarPedidos(dia) {
      return structuredClone(pedidos.filter((p) => p.dia === dia).sort((a, b) => a.numero - b.numero));
    },
    async mudarSituacao(id, situacao) {
      const p = pedidos.find((x) => x.id === id);
      if (!p) return null;
      p.situacao = situacao;
      return structuredClone(p);
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

export async function criarBancoPostgres(url) {
  const { default: pg } = await import('pg');
  pg.types.setTypeParser(1082, (v) => v); // date como texto, sem fuso
  const local = /localhost|127\.0\.0\.1/.test(url);
  const pool = new pg.Pool({
    connectionString: url,
    ssl: local ? false : { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30_000,
  });

  return {
    tipo: 'postgres',
    async iniciar() {
      await pool.query(MIGRACAO);
    },
    async fechar() {
      await pool.end();
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
    async mudarSituacao(id, situacao) {
      const { rows } = await pool.query('UPDATE pedidos SET situacao = $2 WHERE id = $1 RETURNING *', [id, situacao]);
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
