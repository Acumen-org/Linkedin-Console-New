import { api } from './api';

/** Web push needs a service worker, HTTPS (or localhost) and browser support. */
export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && window.isSecureContext;

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return null;
  return navigator.serviceWorker.register('/sw.js');
}

function urlBase64ToUint8Array(base64: string) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

export async function enablePush(vapidPublicKey: string) {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications were blocked in this browser');
  const reg = (await registerServiceWorker()) ?? (await navigator.serviceWorker.ready);
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) });
  await api.post('/api/push/subscriptions', sub.toJSON());
}

export async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return;
  await api.del('/api/push/subscriptions', { endpoint: sub.endpoint });
  await sub.unsubscribe();
}
