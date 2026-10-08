#!/usr/bin/env bash
# Fills in every required secret in .env that is missing or empty (new ones added by updates included).
# Sourced by install.sh, update.sh and migrate-from-linkunify.sh; safe to run any number of times.
ensure_secrets() {
  local key
  for key in POSTGRES_PASSWORD POD_AGENT_TOKEN LIVE_SECRET REDIS_PASSWORD; do
    grep -qE "^${key}=" .env || echo "${key}=" >> .env
    if grep -qE "^${key}=$" .env; then
      sed -i "s#^${key}=\$#${key}=$(openssl rand -hex 24)#" .env
      echo "Generated ${key} in .env"
    fi
  done
}
