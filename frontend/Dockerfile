FROM node:20-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ARG VITE_API_URL
ARG VITE_REGISTRATION_ENABLED=false
ENV VITE_API_URL=${VITE_API_URL}
ENV VITE_REGISTRATION_ENABLED=${VITE_REGISTRATION_ENABLED}

RUN npm run build

FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
