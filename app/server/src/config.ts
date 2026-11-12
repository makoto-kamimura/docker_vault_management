import { readFileSync } from 'node:fs';
import { z } from 'zod';

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export type Env = Record<string, string | undefined>;
export type ReadFile = (path: string) => string;

/** Variables that may also be supplied as `<NAME>_FILE` (Docker / Kubernetes secrets). */
const FILE_CAPABLE = [
  'DATABASE_URL',
  'TOKEN_SECRET',
  'PRELOGIN_SECRET',
  'APNS_KEY_P8',
  'FCM_SERVICE_ACCOUNT_JSON',
] as const;

export type ApnsConfig = {
  keyId: string;
  teamId: string;
  keyP8: string;
  topic: string;
  production: boolean;
};
export type FcmConfig = {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
};

export type Config = {
  databaseUrl: string;
  publicOrigin: string;
  tokenSecret: string;
  preloginSecret: string;
  registrationMode: 'invite' | 'closed' | 'open';
  trustProxy: number;
  logLevel: string;
  host: string;
  port: number;
  migrationsDir: string | undefined;
  apns: ApnsConfig | null;
  fcm: FcmConfig | null;
};

const fcmJsonSchema = z.object({
  project_id: z.string().min(1),
  client_email: z.string().min(1),
  private_key: z.string().min(1),
  token_uri: z.string().url().optional(),
});

const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1)
    .refine((s) => /^postgres(ql)?:\/\//.test(s), 'must be a postgres:// URL'),
  PUBLIC_ORIGIN: z.string().refine((s) => {
    try {
      const u = new URL(s);
      return (
        (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === s.replace(/\/$/, '')
      );
    } catch {
      return false;
    }
  }, 'must be an origin such as https://vault.example.net'),
  TOKEN_SECRET: z.string().refine((s) => Buffer.byteLength(s) >= 32, 'must be at least 32 bytes'),
  PRELOGIN_SECRET: z
    .string()
    .refine((s) => Buffer.byteLength(s) >= 32, 'must be at least 32 bytes'),
  REGISTRATION_MODE: z.enum(['invite', 'closed', 'open']).default('invite'),
  TRUST_PROXY: z
    .string()
    .regex(/^\d{1,3}$/, 'must be an integer >= 0')
    .default('0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z
    .string()
    .regex(/^\d{1,5}$/, 'must be a port number')
    .default('8787'),
  MIGRATIONS_DIR: z.string().min(1).optional(),
  APNS_KEY_ID: z.string().min(1).optional(),
  APNS_TEAM_ID: z.string().min(1).optional(),
  APNS_KEY_P8: z.string().min(1).optional(),
  APNS_TOPIC: z.string().min(1).optional(),
  APNS_PRODUCTION: z.enum(['true', 'false']).default('false'),
  FCM_SERVICE_ACCOUNT_JSON: z.string().min(1).optional(),
});

/** Resolve `NAME` or `NAME_FILE` into a plain env map. Reports names only, never values. */
function resolveEnv(env: Env, readFile: ReadFile, problems: string[]): Env {
  // An empty value means "not set": Compose writes `${VAR:-}` as an empty string, and an optional
  // secret file may be an empty placeholder.
  const out: Env = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== '') out[k] = v;
  for (const name of FILE_CAPABLE) {
    const file = env[`${name}_FILE`];
    if (file === undefined || file === '') continue;
    if (env[name] !== undefined && env[name] !== '') {
      problems.push(`${name}: set either ${name} or ${name}_FILE, not both`);
      continue;
    }
    try {
      const value = readFile(file).replace(/\r?\n$/, '');
      if (value !== '') out[name] = value;
    } catch {
      problems.push(`${name}_FILE: cannot read the file`);
    }
  }
  return out;
}

function toConfig(parsed: z.infer<typeof envSchema>, problems: string[]): Config {
  const apnsParts = [
    parsed.APNS_KEY_ID,
    parsed.APNS_TEAM_ID,
    parsed.APNS_KEY_P8,
    parsed.APNS_TOPIC,
  ];
  const apnsCount = apnsParts.filter((v) => v !== undefined).length;
  let apns: ApnsConfig | null = null;
  if (apnsCount > 0 && apnsCount < 4) {
    problems.push(
      'APNS_*: APNS_KEY_ID, APNS_TEAM_ID, APNS_KEY_P8 and APNS_TOPIC must be set together',
    );
  } else if (apnsCount === 4) {
    apns = {
      keyId: parsed.APNS_KEY_ID as string,
      teamId: parsed.APNS_TEAM_ID as string,
      keyP8: parsed.APNS_KEY_P8 as string,
      topic: parsed.APNS_TOPIC as string,
      production: parsed.APNS_PRODUCTION === 'true',
    };
  }
  let fcm: FcmConfig | null = null;
  if (parsed.FCM_SERVICE_ACCOUNT_JSON !== undefined) {
    let json: unknown;
    try {
      json = JSON.parse(parsed.FCM_SERVICE_ACCOUNT_JSON);
    } catch {
      problems.push('FCM_SERVICE_ACCOUNT_JSON: not valid JSON');
    }
    if (json !== undefined) {
      const r = fcmJsonSchema.safeParse(json);
      if (r.success) {
        fcm = {
          projectId: r.data.project_id,
          clientEmail: r.data.client_email,
          privateKey: r.data.private_key,
          tokenUri: r.data.token_uri ?? 'https://oauth2.googleapis.com/token',
        };
      } else {
        problems.push('FCM_SERVICE_ACCOUNT_JSON: missing project_id, client_email or private_key');
      }
    }
  }
  return {
    databaseUrl: parsed.DATABASE_URL,
    publicOrigin: parsed.PUBLIC_ORIGIN.replace(/\/$/, ''),
    tokenSecret: parsed.TOKEN_SECRET,
    preloginSecret: parsed.PRELOGIN_SECRET,
    registrationMode: parsed.REGISTRATION_MODE,
    trustProxy: Number(parsed.TRUST_PROXY),
    logLevel: parsed.LOG_LEVEL,
    host: parsed.HOST,
    port: Number(parsed.PORT),
    migrationsDir: parsed.MIGRATIONS_DIR,
    apns,
    fcm,
  };
}

/**
 * Validate the whole server configuration. The error message lists variable names and the reason,
 * never the values (they may be secrets).
 */
export function loadConfig(
  env: Env = process.env,
  readFile: ReadFile = (p) => readFileSync(p, 'utf8'),
): Config {
  const problems: string[] = [];
  const resolved = resolveEnv(env, readFile, problems);
  const r = envSchema.safeParse(resolved);
  if (!r.success) {
    for (const issue of r.error.issues) {
      const name = issue.path.join('.') || 'env';
      const missing = issue.code === 'invalid_type' && resolved[name] === undefined;
      problems.push(`${name}: ${missing ? 'is required' : issue.message}`);
    }
  }
  const config = r.success ? toConfig(r.data, problems) : null;
  if (problems.length > 0 || config === null) {
    throw new ConfigError(`invalid configuration:\n- ${problems.join('\n- ')}`);
  }
  return config;
}

/** Minimal configuration for CLI commands that only need the database. */
export function loadDatabaseConfig(
  env: Env = process.env,
  readFile: ReadFile = (p) => readFileSync(p, 'utf8'),
): { databaseUrl: string; migrationsDir: string | undefined } {
  const problems: string[] = [];
  const resolved = resolveEnv(env, readFile, problems);
  const r = envSchema.pick({ DATABASE_URL: true, MIGRATIONS_DIR: true }).safeParse(resolved);
  if (!r.success) {
    for (const issue of r.error.issues) {
      const name = issue.path.join('.') || 'env';
      problems.push(`${name}: ${resolved[name] === undefined ? 'is required' : issue.message}`);
    }
  }
  if (problems.length > 0 || !r.success) {
    throw new ConfigError(`invalid configuration:\n- ${problems.join('\n- ')}`);
  }
  return { databaseUrl: r.data.DATABASE_URL, migrationsDir: r.data.MIGRATIONS_DIR };
}
