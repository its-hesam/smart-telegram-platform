FROM node:24-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/ packages/
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npm run build
RUN node node_modules/playwright/cli.js install --with-deps chromium && mkdir -p /profiles/encrypted /profiles/runtime && chown -R node:node /profiles
USER node
EXPOSE 3000 3001
CMD ["node", "dist/apps/api/src/main.js"]
