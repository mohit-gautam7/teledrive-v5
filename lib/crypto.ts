import crypto from "crypto";
import { env } from "@/lib/env";

export function encryptSecret(value: string) {
  if (!env.SESSION_ENCRYPTION_KEY) return value;
  const key = crypto.createHash("sha256").update(env.SESSION_ENCRYPTION_KEY).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${encrypted.toString("base64")}`;
}

export function decryptSecret(value?: string | null) {
  if (!value || !env.SESSION_ENCRYPTION_KEY || !value.includes(".")) return value || null;
  const [ivRaw, tagRaw, encryptedRaw] = value.split(".");
  const key = crypto.createHash("sha256").update(env.SESSION_ENCRYPTION_KEY).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw, "base64"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64")),
    decipher.final()
  ]).toString("utf8");
}
