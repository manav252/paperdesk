import type { Pool } from 'pg';

export type KvRow<T> = { key: string; value: T; updated: number };

/**
 * Small keyed storage for features that need a few rows each (lookup cache, chat, notifications, repository links):
 * one Postgres table in production, and memory with local file storage so development and tests need no database.
 */
export class Kv {
  private memory = new Map<string, Map<string, { value: unknown; updated: number }>>();
  constructor(private pool: Pool | null) {}

  async initialize() {
    await this.pool?.query(`CREATE TABLE IF NOT EXISTS paperdesk_kv (scope text NOT NULL, key text NOT NULL, value jsonb NOT NULL, updated bigint NOT NULL, PRIMARY KEY (scope, key))`);
  }

  async get<T>(scope: string, key: string): Promise<KvRow<T> | null> {
    if (!this.pool) { const row = this.memory.get(scope)?.get(key); return row ? { key, value: row.value as T, updated: row.updated } : null; }
    const { rows } = await this.pool.query('SELECT value, updated FROM paperdesk_kv WHERE scope = $1 AND key = $2', [scope, key]);
    return rows[0] ? { key, value: rows[0].value as T, updated: Number(rows[0].updated) } : null;
  }

  async set(scope: string, key: string, value: unknown) {
    const updated = Date.now();
    if (!this.pool) { let rows = this.memory.get(scope); if (!rows) { rows = new Map(); this.memory.set(scope, rows); } rows.set(key, { value, updated }); return; }
    await this.pool.query(`INSERT INTO paperdesk_kv (scope, key, value, updated) VALUES ($1,$2,$3,$4) ON CONFLICT (scope, key) DO UPDATE SET value = EXCLUDED.value, updated = EXCLUDED.updated`, [scope, key, JSON.stringify(value), updated]);
  }

  async delete(scope: string, key?: string) {
    if (!this.pool) { if (key === undefined) this.memory.delete(scope); else this.memory.get(scope)?.delete(key); return; }
    if (key === undefined) await this.pool.query('DELETE FROM paperdesk_kv WHERE scope = $1', [scope]);
    else await this.pool.query('DELETE FROM paperdesk_kv WHERE scope = $1 AND key = $2', [scope, key]);
  }

  /** Rows of a scope ordered by key (newest first with `desc`). */
  async list<T>(scope: string, { limit = 200, desc = false } = {}): Promise<KvRow<T>[]> {
    if (!this.pool) {
      const rows = [...(this.memory.get(scope) ?? [])].map(([key, row]) => ({ key, value: row.value as T, updated: row.updated })).sort((a, b) => a.key < b.key ? -1 : 1);
      return (desc ? rows.reverse() : rows).slice(0, limit);
    }
    const { rows } = await this.pool.query(`SELECT key, value, updated FROM paperdesk_kv WHERE scope = $1 ORDER BY key ${desc ? 'DESC' : 'ASC'} LIMIT $2`, [scope, limit]);
    return rows.map(r => ({ key: String(r.key), value: r.value as T, updated: Number(r.updated) }));
  }
}
