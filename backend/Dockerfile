FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ARG RELEASE_COMMIT=unknown
ARG BUILD_ID=local-container
ENV NODE_ENV=production
ENV RELEASE_COMMIT=$RELEASE_COMMIT
ENV BUILD_ID=$BUILD_ID

EXPOSE 8080

USER node

CMD ["node", "server.js"]
