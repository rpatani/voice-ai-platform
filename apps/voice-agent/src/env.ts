/**
 * All environment configuration for the voice-agent service, read once at
 * startup. Simulation mode (`SIMULATION=true`) forces mock providers and
 * in-memory persistence so the whole platform runs with zero credentials.
 */
export interface AppEnv {
  port: number;
  /** Public hostname (no scheme) Twilio should stream media to, e.g. an ngrok domain. */
  publicHost: string;
  simulation: boolean;
  persistence: 'memory' | 'postgres';
  databaseUrl?: string;
  redisUrl?: string;
  tenantConfigDir: string;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  deepgramApiKey?: string;
  openaiApiKey?: string;
  /** Groq API key - reuses the OpenAI-compatible LLM adapter (free tier). */
  groqApiKey?: string;
  /** Override the Groq base URL (defaults to https://api.groq.com/openai). */
  groqBaseUrl?: string;
  elevenlabsApiKey?: string;
  calcomApiKey?: string;
}

export function loadEnv(env: NodeJS.ProcessEnv = process.env): AppEnv {
  const simulation = env.SIMULATION === 'true' || env.SIMULATION === '1';
  const persistence = env.PERSISTENCE === 'postgres' ? 'postgres' : 'memory';
  if (persistence === 'postgres' && !env.DATABASE_URL) {
    throw new Error('PERSISTENCE=postgres requires DATABASE_URL');
  }
  return {
    port: Number(env.PORT ?? 8080),
    publicHost: env.PUBLIC_HOST ?? `localhost:${env.PORT ?? 8080}`,
    simulation,
    persistence,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    tenantConfigDir: env.TENANT_CONFIG_DIR ?? new URL('../../../packages/config/tenants', import.meta.url).pathname,
    twilioAccountSid: env.TWILIO_ACCOUNT_SID,
    twilioAuthToken: env.TWILIO_AUTH_TOKEN,
    deepgramApiKey: env.DEEPGRAM_API_KEY,
    openaiApiKey: env.OPENAI_API_KEY,
    groqApiKey: env.GROQ_API_KEY,
    groqBaseUrl: env.GROQ_BASE_URL,
    elevenlabsApiKey: env.ELEVENLABS_API_KEY,
    calcomApiKey: env.CALCOM_API_KEY,
  };
}
