# One real (headful) Google Chrome per LinkedIn account (an "account pod"),
# rendered into a virtual display (Xvfb). Humans see it through the CDP-screencast Live View.
FROM debian:bookworm-slim

# Changes weekly (set by scripts/update.sh): forces a fresh Chrome download instead of a cached old build,
# so security fixes arrive and the version LinkedIn sees doesn't age.
ARG CHROME_REFRESH=initial
RUN set -eux; \
    echo "chrome refresh: ${CHROME_REFRESH}"; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates wget xvfb dumb-init curl \
      fonts-liberation fonts-noto fonts-noto-cjk fonts-noto-color-emoji; \
    wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb; \
    apt-get install -y --no-install-recommends /tmp/chrome.deb; \
    rm -f /tmp/chrome.deb; \
    apt-get clean; rm -rf /var/lib/apt/lists/*; \
    useradd -m -u 1000 chrome; \
    mkdir -p /data/profile /data/files; chown -R chrome:chrome /data

COPY policies.json /etc/opt/chrome/policies/managed/policies.json
COPY --chmod=755 start.sh /start.sh

USER chrome
ENTRYPOINT ["dumb-init", "--"]
CMD ["/start.sh"]
