FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553
# apt uses the distribution's signed indexes; never use insecure overrides.
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb libnss3-tools iptables util-linux ca-certificates python3 \
    libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
    libasound2 libpango-1.0-0 libcairo2 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/acceptance
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && npx --no-install playwright install chromium \
 && mkdir /opt/chromium \
 && cp -a /root/.cache/ms-playwright/chromium-*/chrome-linux* /opt/chromium/ \
 && if [ -d /opt/chromium/chrome-linux64 ]; then mv /opt/chromium/chrome-linux64 /opt/chromium/chrome-linux; fi \
 && rm -rf /root/.cache/ms-playwright \
 && npm cache clean --force
ENV HOME=/profile/home DISPLAY=:99
