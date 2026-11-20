-- Proxy pool (multi-proxy). Ships OFF (config.multiProxy); while off the app behaves exactly as before — one optional
-- proxy field per account. An admin registers a proxy once; each account is pinned to at most one and is never rotated
-- or moved automatically. The chosen proxy's address is ALSO copied into accounts.proxy_server, so the browser,
-- recovery and pod code paths are byte-for-byte unchanged and an account that does not use the pool is untouched.
CREATE TABLE IF NOT EXISTS proxies (
  id           text PRIMARY KEY,
  label        text NOT NULL,
  -- scheme://host:port (http(s) may carry user:pass). Stored like today's per-account field; never returned by the API.
  address      text NOT NULL,
  max_accounts integer NOT NULL DEFAULT 1 CHECK (max_accounts >= 1 AND max_accounts <= 50),
  disabled_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Which pool proxy an account is pinned to (NULL = not using the pool). ON DELETE SET NULL is a safety net; the API
-- refuses to delete a proxy that still has accounts, so this only fires if a row is removed out of band.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS proxy_id text REFERENCES proxies(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_accounts_proxy_id ON accounts(proxy_id) WHERE proxy_id IS NOT NULL;
