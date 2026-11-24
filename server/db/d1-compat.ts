import type { Database, SQLQueryBindings } from 'bun:sqlite';

type Bind = SQLQueryBindings | null | undefined;
type Row = Record<string, unknown>;

function normalize(values: unknown[]): Bind[] {
  return values.map((value) => {
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value instanceof Date) return value.toISOString();
    return value as Bind;
  });
}

class CompatStatement {
  private params: Bind[] = [];
  private statement: ReturnType<Database['query']> | null = null;

  constructor(
    private db: Database,
    private sql: string
  ) {}

  bind(...values: unknown[]) {
    this.params = normalize(values);
    return this;
  }

  private prepared() {
    if (!this.statement) this.statement = this.db.query(this.sql);
    return this.statement;
  }

  allSync(): Row[] {
    return this.prepared().all(...this.params) as Row[];
  }

  firstSync(): Row | null {
    return (this.prepared().get(...this.params) as Row | null) ?? null;
  }

  runSync() {
    const statement = this.prepared();
    // D1 batch() exposes SELECT results as { results } too; keep that contract.
    if (statement.columnNames.length > 0) {
      const results = statement.all(...this.params) as Row[];
      const info = this.db.query('SELECT last_insert_rowid() AS id, changes() AS changes').get() as {
        id: number;
        changes: number;
      };
      return {
        success: true,
        results,
        meta: {
          last_row_id: Number(info?.id || 0),
          changes: Number(info?.changes || 0),
          rows_read: results.length,
          rows_written: 0
        }
      };
    }
    const info = statement.run(...this.params);
    return {
      success: true,
      results: [] as Row[],
      meta: {
        last_row_id: Number(info.lastInsertRowid),
        changes: info.changes,
        rows_read: 0,
        rows_written: info.changes
      }
    };
  }

  async all() {
    const results = this.allSync();
    return { results, success: true, meta: { rows_read: results.length } };
  }

  async first<T = Row>(column?: string): Promise<T | null> {
    const row = this.firstSync();
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }

  async run() {
    return this.runSync();
  }

  async raw() {
    return this.allSync();
  }
}

/**
 * D1-compatible facade over a single synchronous bun:sqlite connection.
 * Business modules keep using prepare/bind/all/first/run/batch unchanged.
 */
export class D1Compat {
  constructor(private db: Database) {}

  prepare(sql: string) {
    return new CompatStatement(this.db, sql);
  }

  async batch(statements: CompatStatement[]) {
    const tx = this.db.transaction(() => statements.map((statement) => statement.runSync()));
    return tx();
  }

  async exec(sql: string) {
    this.db.exec(sql);
    return { success: true, meta: {} };
  }

  get rawDb() {
    return this.db;
  }
}
