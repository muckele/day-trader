FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

COPY . .

ENV NODE_ENV=production

EXPOSE 8080

CMD ["node", "server.js"]
