#!/usr/bin/env bash
# Helpers for .env, sourced by install.sh, update.sh, capture.sh and migrate-from-linkunify.sh.

# Fills in every required secret in .env that is missing or empty (new ones added by updates included).
# Safe to run any number of times.
ensure_secrets() {
  local key
  for key in POSTGRES_PASSWORD POD_AGENT_TOKEN LIVE_SECRET REDIS_PASSWORD; do
    if ! grep -qE "^${key}=." .env; then
      set_env "$key" "$(openssl rand -hex 24)"
      echo "Generated ${key} in .env"
    fi
  done
}

# Sets KEY=VALUE in .env (replacing the line, or adding it). The value is passed through the environment,
# so characters like & # / \ in it can't break the edit (sed would treat them as syntax).
set_env() {
  local key=$1
  ENV_KEY="$key" ENV_VALUE="$2" awk '
    BEGIN { k = ENVIRON["ENV_KEY"]; v = ENVIRON["ENV_VALUE"]; done = 0 }
    index($0, k "=") == 1 { if (!done) print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' .env > .env.tmp && mv .env.tmp .env
}
