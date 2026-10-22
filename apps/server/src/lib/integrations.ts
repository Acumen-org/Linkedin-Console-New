// Admin-managed Twenty CRM + staff-sync settings, stored in the DB (settings key `integrations`) and layered over
// the env defaults in config.ts. Secrets (Twenty API key, Microsoft client secret) are encrypted at rest with the
// same AES-256-GCM box as LinkedIn passwords (CREDENTIALS_KEY). Loaded at boot and refreshed periodically so an
// edit on the api process reaches the worker, and applied through config.applyIntegrationOverrides so every existing
// `config.twenty` / `config.crmSync` / `config.staffSync` / `config.microsoft` reader picks it up with no change.
import { applyIntegrationOverrides, config, type IntegrationOverrides } from './config.ts';
import { getSetting, setSetting } from './db.ts';
import { logger } from './logger.ts';
import { credentialsEnabled, decryptSecret, encryptSecret } from './secretbox.ts';

const KEY = 'integrations';
const REFRESH_MS = 15_000;

interface StoredTwenty {
  url: string;
  apiKeyEnc: string;
  webUrl?: string;
  ownerField?: string;
  podField?: string;
}
interface StoredMicrosoft {
  tenantId: string;
  clientId: string;
  clientSecretEnc: string;
}
interface Stored {
  crmSync?: boolean;
  crmAutoCreate?: boolean;
  crmFuzzyBind?: boolean;
  twenty?: StoredTwenty | null;
  microsoft?: StoredMicrosoft | null;
  staffSync?: { mode?: 'off' | 'disable' | 'provision'; source?: 'twilio' | 'twenty' };
}

const webUrlFrom = (apiUrl: string, webUrl: string) => (webUrl || apiUrl.replace(/\/graphql\/?$/, '')).replace(/\/$/, '');

function toOverrides(s: Stored): IntegrationOverrides {
  const o: IntegrationOverrides = {};
  if (typeof s.crmSync === 'boolean') o.crmSync = s.crmSync;
  if (typeof s.crmAutoCreate === 'boolean') o.crmAutoCreate = s.crmAutoCreate;
  if (typeof s.crmFuzzyBind === 'boolean') o.crmFuzzyBind = s.crmFuzzyBind;
  if (s.twenty !== undefined) {
    // A stored connection whose key can't be decrypted (CREDENTIALS_KEY gone) falls back to env instead of breaking.
    const apiKey = s.twenty?.apiKeyEnc ? safeDecrypt(s.twenty.apiKeyEnc) : '';
    o.twenty =
      s.twenty?.url && apiKey
        ? {
            url: s.twenty.url,
            apiKey,
            webUrl: webUrlFrom(s.twenty.url, s.twenty.webUrl ?? ''),
            ownerField: s.twenty.ownerField || 'assignedTo',
            podField: s.twenty.podField || 'pod',
          }
        : s.twenty === null
          ? null
          : undefined;
    if (o.twenty === undefined) delete o.twenty;
  }
  if (s.microsoft !== undefined) {
    const clientSecret = s.microsoft?.clientSecretEnc ? safeDecrypt(s.microsoft.clientSecretEnc) : '';
    o.microsoft =
      s.microsoft?.tenantId && s.microsoft.clientId && clientSecret
        ? { tenantId: s.microsoft.tenantId, clientId: s.microsoft.clientId, clientSecret }
        : s.microsoft === null
          ? null
          : undefined;
    if (o.microsoft === undefined) delete o.microsoft;
  }
  if (s.staffSync) {
    o.staffSync = {};
    if (s.staffSync.mode) o.staffSync.mode = s.staffSync.mode;
    if (s.staffSync.source) o.staffSync.source = s.staffSync.source;
  }
  return o;
}

function safeDecrypt(blob: string): string {
  try {
    return decryptSecret(blob);
  } catch (err) {
    logger.warn({ err }, 'could not decrypt a stored integration secret (CREDENTIALS_KEY changed or unset)');
    return '';
  }
}

/** Read the admin settings from the DB and apply them over the env defaults. */
export async function loadIntegrations(): Promise<void> {
  try {
    const s = await getSetting<Stored>(KEY);
    applyIntegrationOverrides(s ? toOverrides(s) : {});
  } catch (err) {
    logger.warn({ err }, 'loading integration settings failed; using env defaults');
  }
}

let timer: NodeJS.Timeout | null = null;
/** Load now, then keep refreshing so an edit on one process reaches the others. */
export async function startIntegrations(): Promise<void> {
  await loadIntegrations();
  if (!timer) timer = setInterval(() => loadIntegrations().catch(() => {}), REFRESH_MS).unref();
}

/** Turn auto-create off and persist it (the CRM circuit breaker calls this, so a runaway can't continue past the cap).
 * Merges into the stored settings so the Twenty connection and everything else is untouched. */
export async function disableAutoCreate(): Promise<void> {
  const s = (await getSetting<Stored>(KEY)) ?? {};
  await setSetting(KEY, { ...s, crmAutoCreate: false });
  await loadIntegrations();
}

// ---------- admin API helpers ----------

export interface IntegrationView {
  credentialsEnabled: boolean;
  crmSync: boolean;
  crmAutoCreate: boolean;
  crmFuzzyBind: boolean;
  twenty: { url: string; webUrl: string; ownerField: string; podField: string; apiKeySet: boolean } | null;
  microsoft: { tenantId: string; clientId: string; clientSecretSet: boolean } | null;
  staffSync: { mode: 'off' | 'disable' | 'provision'; source: 'twilio' | 'twenty' };
}

/** The effective settings for the admin UI; secrets are never returned, only whether they are set. */
export function currentIntegrations(): IntegrationView {
  const t = config.twenty;
  const m = config.microsoft;
  return {
    credentialsEnabled: credentialsEnabled(),
    crmSync: config.crmSync,
    crmAutoCreate: config.crmAutoCreate,
    crmFuzzyBind: config.crmFuzzyBind,
    twenty: t ? { url: t.url, webUrl: t.webUrl, ownerField: t.ownerField, podField: t.podField, apiKeySet: !!t.apiKey } : null,
    microsoft: m ? { tenantId: m.tenantId, clientId: m.clientId, clientSecretSet: !!m.clientSecret } : null,
    staffSync: { mode: config.staffSync.mode, source: config.staffSync.source },
  };
}

export interface IntegrationUpdate {
  crmSync?: boolean;
  crmAutoCreate?: boolean;
  crmFuzzyBind?: boolean;
  twenty?: { url?: string; apiKey?: string; webUrl?: string; ownerField?: string; podField?: string; disable?: boolean };
  microsoft?: { tenantId?: string; clientId?: string; clientSecret?: string; disable?: boolean };
  staffSync?: { mode?: 'off' | 'disable' | 'provision'; source?: 'twilio' | 'twenty' };
}

export class IntegrationError extends Error {}

/** Apply an admin edit: validate, encrypt any new secrets, persist, and reload so it takes effect immediately. */
export async function saveIntegrations(update: IntegrationUpdate): Promise<IntegrationView> {
  const stored = (await getSetting<Stored>(KEY)) ?? {};
  const next: Stored = { ...stored };

  if (typeof update.crmSync === 'boolean') next.crmSync = update.crmSync;
  if (typeof update.crmAutoCreate === 'boolean') next.crmAutoCreate = update.crmAutoCreate;
  if (typeof update.crmFuzzyBind === 'boolean') next.crmFuzzyBind = update.crmFuzzyBind;

  if (update.twenty) {
    const u = update.twenty;
    if (u.disable) {
      next.twenty = null;
    } else {
      const prev = stored.twenty ?? null;
      const url = (u.url ?? prev?.url ?? '').trim();
      if (url && !/^https:\/\/.+\/graphql\/?$/i.test(url)) {
        throw new IntegrationError('The Twenty API URL should be the GraphQL endpoint, e.g. https://your-twenty/graphql');
      }
      let apiKeyEnc = prev?.apiKeyEnc ?? '';
      if (u.apiKey) {
        if (!credentialsEnabled()) throw new IntegrationError('Set CREDENTIALS_KEY first to store the Twenty API key securely');
        apiKeyEnc = encryptSecret(u.apiKey.trim());
      }
      if (url && !apiKeyEnc) throw new IntegrationError('A Twenty API key is required');
      next.twenty = url
        ? {
            url,
            apiKeyEnc,
            webUrl: u.webUrl?.trim() || prev?.webUrl,
            ownerField: u.ownerField?.trim() || prev?.ownerField,
            podField: u.podField?.trim() || prev?.podField,
          }
        : null;
    }
  }

  if (update.microsoft) {
    const u = update.microsoft;
    if (u.disable) {
      next.microsoft = null;
    } else {
      const prev = stored.microsoft ?? null;
      const tenantId = (u.tenantId ?? prev?.tenantId ?? '').trim();
      const clientId = (u.clientId ?? prev?.clientId ?? '').trim();
      let clientSecretEnc = prev?.clientSecretEnc ?? '';
      if (u.clientSecret) {
        if (!credentialsEnabled()) throw new IntegrationError('Set CREDENTIALS_KEY first to store the Microsoft client secret securely');
        clientSecretEnc = encryptSecret(u.clientSecret.trim());
      }
      if ((tenantId || clientId || clientSecretEnc) && !(tenantId && clientId && clientSecretEnc)) {
        throw new IntegrationError('Microsoft sign-in needs a tenant ID, client ID and client secret');
      }
      next.microsoft = tenantId ? { tenantId, clientId, clientSecretEnc } : null;
    }
  }

  if (update.staffSync) {
    next.staffSync = { ...stored.staffSync, ...update.staffSync };
    // Provisioning creates members with no password, so Microsoft sign-in must be available (env or just-saved).
    if (next.staffSync.mode === 'provision') {
      const willHaveMicrosoft = next.microsoft !== undefined ? !!next.microsoft : !!config.microsoft;
      if (!willHaveMicrosoft) throw new IntegrationError('Provisioning staff needs Microsoft sign-in configured first');
    }
    if (next.staffSync.source === 'twenty' && !(next.twenty !== undefined ? next.twenty : config.twenty)) {
      throw new IntegrationError('Staff source "Twenty" needs the Twenty connection configured first');
    }
  }

  await setSetting(KEY, next);
  await loadIntegrations();
  return currentIntegrations();
}
