// The X-Registry-Auth header Docker wants for pulling a private image, from a Docker config.json (the node's
// `docker login` file, mounted read-only through REGISTRY_AUTH_FILE). Only plain "auth" entries are supported:
// credential helpers (credsStore) keep the password outside the file.

/** The registry host of an image reference ("h4rb0r.example.com/project/chrome:tag" → "h4rb0r.example.com"). */
export function registryHost(ref: string): string | null {
  const first = ref.split('/')[0];
  return ref.includes('/') && /[.:]/.test(first) ? first : null;
}

/** base64url JSON {username, password, serveraddress}, or null without a login for that registry. */
export function registryAuthHeader(ref: string, dockerConfigJson: string): string | null {
  const host = registryHost(ref);
  if (!host) return null;
  let auths: Record<string, { auth?: string }>;
  try {
    auths = JSON.parse(dockerConfigJson).auths ?? {};
  } catch {
    return null;
  }
  const entry = auths[host] ?? auths[`https://${host}`];
  if (!entry?.auth) return null;
  const decoded = Buffer.from(entry.auth, 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 1) return null;
  return Buffer.from(JSON.stringify({ username: decoded.slice(0, i), password: decoded.slice(i + 1), serveraddress: host })).toString(
    'base64url',
  );
}
