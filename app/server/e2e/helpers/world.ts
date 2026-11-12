// One isolated test world: its own database (from the shared container), server app, fake clock
// and push sender; devices are created on demand.
import { createTestEnv, type TestEnv } from '../../test/helpers/env';
import { VirtualPc } from './pc';
import { VirtualPhone } from './phone';
import { InProcessTransport, TamperingTransport, type Transport } from './transport';

export class World {
  readonly transport: InProcessTransport;
  private constructor(readonly env: TestEnv) {
    this.transport = new InProcessTransport(env);
  }
  static async create(): Promise<World> {
    return new World(await createTestEnv());
  }
  get clock() {
    return this.env.clock;
  }
  get push() {
    return this.env.push;
  }
  advance(ms: number): void {
    this.env.clock.advance(ms);
  }

  phone(
    o: { platform?: 'ios' | 'android'; name?: string; transport?: Transport } = {},
  ): VirtualPhone {
    return new VirtualPhone(o.transport ?? this.transport, this.env.clock, o);
  }
  pc(transport?: Transport): VirtualPc {
    return new VirtualPc(transport ?? this.transport, this.env.clock);
  }
  tampering(): TamperingTransport {
    return new TamperingTransport(this.transport);
  }

  /** Every cell of every table, bytea rendered as hex, utf-8, base64 and base64url. */
  async dumpDatabase(): Promise<string> {
    const pool = this.env.handle.pool;
    const tables = await pool.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public'",
    );
    const parts: string[] = [];
    for (const { table_name } of tables.rows) {
      const rows = await pool.query(`select * from "${table_name}"`);
      for (const row of rows.rows) {
        for (const [k, v] of Object.entries(row)) {
          parts.push(k);
          if (v instanceof Uint8Array) {
            const b = Buffer.from(v);
            parts.push(
              b.toString('hex'),
              b.toString('utf8'),
              b.toString('latin1'),
              b.toString('base64'),
              b.toString('base64url'),
            );
          } else if (v !== null && typeof v === 'object') {
            parts.push(JSON.stringify(v));
          } else {
            parts.push(String(v));
          }
        }
      }
    }
    return parts.join('\n');
  }

  close(): Promise<void> {
    return this.env.close();
  }
}

let n = 0;
export const uniqueName = (prefix = 'user') => `${prefix}${Date.now().toString(36)}${n++}`;
