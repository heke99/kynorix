import pg, { type PoolClient, type QueryResultRow } from 'pg';
import type { ApiConfig } from './config.js';

const { Pool } = pg;

export class Database {
  readonly pool: pg.Pool;

  constructor(config: ApiConfig) {
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: 20,
      statement_timeout: 15_000,
      application_name: 'kynorix-api',
      ssl:
        config.databaseSsl === 'disable'
          ? false
          : { rejectUnauthorized: config.databaseSsl === 'verify-full' },
    });
    this.pool.on('error', (error) => {
      process.stderr.write(`Database pool error: ${error.message}\n`);
    });
  }

  async health(): Promise<{ ok: boolean; migrationVersion: string | null }> {
    try {
      const result = await this.pool.query<{ version: string | null }>(
        'select max(version) as version from public.schema_migrations',
      );
      return { ok: true, migrationVersion: result.rows[0]?.version ?? null };
    } catch {
      return { ok: false, migrationVersion: null };
    }
  }

  async query<T extends QueryResultRow>(text: string, values: unknown[] = []) {
    return this.pool.query<T>(text, values);
  }

  async transaction<T>(
    context: { tenantId?: string; userId?: string },
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      if (context.tenantId) {
        await client.query("select set_config('app.tenant_id', $1, true)", [context.tenantId]);
      }
      if (context.userId) {
        await client.query("select set_config('app.user_id', $1, true)", [context.userId]);
      }
      const result = await operation(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
