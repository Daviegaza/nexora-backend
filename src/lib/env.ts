import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().optional(),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  KRA_ETIMS_BASE_URL: z.string().url().optional(),
  KRA_ETIMS_TIN: z.string().optional(),
  KRA_ETIMS_BHF_ID: z.string().default('00'),
  KRA_ETIMS_API_KEY: z.string().optional(),

  MPESA_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  MPESA_CONSUMER_KEY: z.string().optional(),
  MPESA_CONSUMER_SECRET: z.string().optional(),
  MPESA_SHORTCODE: z.string().optional(),
  MPESA_PASSKEY: z.string().optional(),
  MPESA_CALLBACK_BASE: z.string().url().optional(),

  AI_PROVIDER: z.enum(['anthropic', 'openai']).default('anthropic'),
  AI_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  AI_API_KEY: z.string().optional(),
});

export const env = schema.parse(process.env);
