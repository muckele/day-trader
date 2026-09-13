FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS install

# Official Debian security updates are inherited before selecting runtime files.
# Keep package managers and their essential-tool dependencies in this stage only.
RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY . .
RUN node docker/assemble-runtime.cjs

# Same official Node binary and Debian glibc; no Alpine/musl or custom binaries.
FROM scratch AS runtime
COPY --from=install /runtime-root/ /
WORKDIR /app
ENV NODE_ENV=production \
    PATH=/usr/local/bin \
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
USER 1000:1000
EXPOSE 8080
CMD ["/usr/local/bin/node", "server.js"]
