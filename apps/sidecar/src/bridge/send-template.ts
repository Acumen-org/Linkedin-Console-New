// Fast sending: LinkedIn's web app sends a message with one "create message" request. We learn that
// request from a real send (ours through the UI, or a teammate's in Live View) and replay it from inside
// the page for later messages. Nothing about its format is hard-coded: if LinkedIn changes it, the replay
// is rejected, the template is dropped and the next send goes through the UI again (which re-learns it).
import crypto from 'node:crypto';

const CREATE_MESSAGE = /\/voyager\/api\/.*messeng.*[?&]action=createMessage/i;

export const isCreateMessageRequest = (method: string, url: string) => method === 'POST' && CREATE_MESSAGE.test(url);

type Json = unknown;

/** A new value shaped like LinkedIn's (UUID, base64 or raw-byte string of the same size). */
function randomLike(sample: string) {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sample)) return crypto.randomUUID();
  if (/^[A-Za-z0-9+/]{8,}={0,2}$/.test(sample)) return crypto.randomBytes(Buffer.from(sample, 'base64').length).toString('base64');
  return Array.from(crypto.randomBytes(sample.length), (b) => String.fromCharCode(b)).join('');
}

const hasAttachments = (node: Json): boolean => {
  if (Array.isArray(node)) return node.some(hasAttachments);
  if (!node || typeof node !== 'object') return false;
  return Object.entries(node).some(([k, v]) => (k === 'renderContentUnions' && Array.isArray(v) && v.length > 0) || hasAttachments(v));
};

/**
 * The request body for a new message: same shape as the template, with this conversation and text and
 * fresh client tokens. Null if the template doesn't look like a text message to an existing conversation.
 */
export function fillSendBody(template: string, conversationUrn: string, text: string): string | null {
  let json: Json;
  try {
    json = JSON.parse(template);
  } catch {
    return null;
  }
  if (hasAttachments(json)) return null;
  let urn = false;
  let body = false;
  const walk = (node: Json) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, Json>;
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'conversationUrn' && typeof v === 'string') {
        obj[k] = conversationUrn;
        urn = true;
      } else if ((k === 'originToken' || k === 'trackingId') && typeof v === 'string') {
        obj[k] = randomLike(v);
      } else if (k === 'body' && v && typeof v === 'object' && typeof (v as Record<string, Json>).text === 'string') {
        const b = v as Record<string, Json>;
        b.text = text;
        if (Array.isArray(b.attributes)) b.attributes = []; // mentions/formatting of the original message
        body = true;
      } else {
        walk(v);
      }
    }
  };
  walk(json);
  return urn && body ? JSON.stringify(json) : null;
}

/** The template to keep: the captured body with the original conversation and text removed. */
export const scrubSendBody = (body: string) => fillSendBody(body, '', '');
