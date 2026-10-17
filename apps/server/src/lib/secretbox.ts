// Encrypt small secrets (LinkedIn account passwords) at rest with AES-256-GCM, keyed by CREDENTIALS_KEY.
// Stored as "v1:<iv>:<tag>:<ciphertext>" (all base64). The key never leaves the server; the plaintext is
// only decrypted when the worker auto-logs-in or the Live-window gate checks a typed password.
import crypto from 'node:crypto';
import { config } from './config.ts';

/** Whether storing/using LinkedIn credentials is enabled (CREDENTIALS_KEY set). */
export const credentialsEnabled = () => config.credentialsKey !== null;

export function encryptSecret(plaintext: string): string {
  const key = config.credentialsKey;
  if (!key) throw new Error('CREDENTIALS_KEY is not set');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decryptSecret(blob: string): string {
  const key = config.credentialsKey;
  if (!key) throw new Error('CREDENTIALS_KEY is not set');
  const [v, ivB64, tagB64, dataB64] = blob.split(':');
  if (v !== 'v1' || !ivB64 || !tagB64 || !dataB64) throw new Error('bad secret format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

/** Constant-time compare of a typed password against a stored encrypted one. */
export function secretEquals(blob: string, candidate: string): boolean {
  let stored: string;
  try {
    stored = decryptSecret(blob);
  } catch {
    return false;
  }
  const a = Buffer.from(stored, 'utf8');
  const b = Buffer.from(candidate, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
