import crypto from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function random(len: number) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

/** Prefixed random ids, e.g. msg_x1y2… */
export const newId = (prefix: string) => `${prefix}_${random(16)}`;

/** Account ids double as container names: exactly 12 chars of [a-z0-9]. */
export const newAccountId = () => random(12);
