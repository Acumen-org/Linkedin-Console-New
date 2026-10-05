import webpush from 'web-push';
import { config } from './config.ts';
import { getSetting, setSetting } from './db.ts';

type VapidKeys = { publicKey: string; privateKey: string };
let cached: VapidKeys | null = null;

/** Web-push keys: generated on first use and stored in the database (no manual setup). */
export async function vapidKeys(): Promise<VapidKeys> {
  if (cached) return cached;
  let keys = await getSetting<VapidKeys>('vapid');
  if (!keys) {
    keys = webpush.generateVAPIDKeys();
    await setSetting('vapid', keys);
  }
  webpush.setVapidDetails(config.vapidSubject, keys.publicKey, keys.privateKey);
  cached = keys;
  return keys;
}
