#!/bin/sh
set -eu

SCREEN_W="${SCREEN_W:-1440}"
SCREEN_H="${SCREEN_H:-900}"

Xvfb :99 -screen 0 "${SCREEN_W}x${SCREEN_H}x24" -nolisten tcp &
export DISPLAY=:99
sleep 1

# Remove a stale lock if the container was killed (profile is on a volume).
rm -f /data/profile/SingletonLock /data/profile/SingletonSocket /data/profile/SingletonCookie

PROXY_FLAG=""
if [ -n "${PROXY_SERVER:-}" ]; then
  PROXY_FLAG="--proxy-server=${PROXY_SERVER}"
fi

# --remote-debugging-port binds to 127.0.0.1 only; liveview + bridge share this
# container's network namespace, so CDP is never exposed.
# --no-sandbox: Chrome's sandbox needs extra kernel privileges inside Docker.
exec google-chrome \
  --user-data-dir=/data/profile \
  --remote-debugging-port=9222 \
  --no-first-run \
  --no-default-browser-check \
  --no-sandbox \
  --password-store=basic \
  --disable-dev-shm-usage \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --disable-background-timer-throttling \
  --lang="${CHROME_LANG:-en-US}" \
  --window-position=0,0 \
  --window-size="${SCREEN_W},${SCREEN_H}" \
  --start-maximized \
  ${PROXY_FLAG} \
  "${START_URL:-https://www.linkedin.com/login}"
