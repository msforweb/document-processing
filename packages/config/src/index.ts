export interface AppConfig {
  databaseUrl: string;
  redisUrl: string;
  jwtSecret: string;
  apiPort: number;
  storagePath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    databaseUrl: env.DATABASE_URL ?? '',
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
    jwtSecret: env.JWT_SECRET ?? 'change-me-in-development',
    apiPort: Number(env.API_PORT ?? 3001),
    storagePath: env.STORAGE_PATH ?? './storage',
  };
}
