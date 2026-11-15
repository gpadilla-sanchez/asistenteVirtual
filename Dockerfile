# Imagen multi-arquitectura: Raspberry Pi 4/5 (arm64) y PC/servidor (amd64).

# ---------- Compilación ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---------- Ejecución ----------
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    TZ=America/Mexico_City \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Chromium compatible con Playwright (incluye la versión arm64 para Raspberry Pi) y sus dependencias
RUN npx playwright-core install --with-deps chromium && rm -rf /var/lib/apt/lists/* /root/.npm
COPY config ./config
COPY config-simulacion ./config-simulacion
RUN mkdir -p data secretos entrada data-simulacion secretos-simulacion && chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:3000/salud').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
