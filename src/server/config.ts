import { DEFAULT_TIMEZONE } from '../domain/time.ts';

export interface AppConfig {
  port: number;
  bindHost: string;
  publicOrigin: string | null;
  timeZone: string;
  storeAdapter: 'file' | 'memory' | 'mongodb';
  localStoreDir: string;
  mongodbUri: string | null;
  mongodbDb: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  aiEnabled: boolean;
  retentionDaysAfterOuting: number;
  secureCookies: boolean;
}

const bool = (v: string | undefined, d: boolean) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const storeAdapter = env.STORE_ADAPTER === 'mongodb' ? 'mongodb' : env.STORE_ADAPTER === 'memory' ? 'memory' : 'file';
  return {
    port: Number(env.APP_PORT ?? 8787),
    // Loopback by default; set APP_BIND_HOST=0.0.0.0 to let phones on the same Wi-Fi connect.
    bindHost: env.APP_BIND_HOST ?? '127.0.0.1',
    publicOrigin: env.PUBLIC_APP_ORIGIN || null,
    timeZone: env.APP_TIMEZONE ?? DEFAULT_TIMEZONE,
    storeAdapter,
    localStoreDir: env.LOCAL_STORE_DIR ?? '.local-data',
    mongodbUri: env.MONGODB_URI || null,
    mongodbDb: env.MONGODB_DB ?? 'common_ground',
    ollamaBaseUrl: env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434',
    ollamaModel: env.OLLAMA_MODEL ?? 'gemma3:4b',
    aiEnabled: bool(env.AI_ENABLED, true),
    retentionDaysAfterOuting: Number(env.RETENTION_DAYS_AFTER_OUTING ?? 7),
    secureCookies: bool(env.SECURE_COOKIES, false),
  };
}
