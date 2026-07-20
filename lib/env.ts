import { z } from "zod";

const envSchema = z.object({
  // Required in production
  BOT_TOKEN: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  JWT_SECRET: z.string().min(24).optional(),
  WEBHOOK_SECRET: z.string().optional(),
  NEXT_PUBLIC_APP_URL: z.string().optional(),

  // Legacy only — recovering files stored by older TeleDrive versions
  BOT_CHANNEL_ID: z.string().optional(),
  API_ID: z.coerce.number().optional(),
  API_HASH: z.string().optional(),
  TELEGRAM_SESSION: z.string().optional(),
  SESSION_ENCRYPTION_KEY: z.string().optional()
});

export const env = envSchema.parse(process.env);

export function requireEnv(name: keyof typeof env) {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
