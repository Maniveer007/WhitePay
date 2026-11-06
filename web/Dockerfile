# WhitePay web app (website, console, operator console). Build context: ./web
# API_ORIGIN is baked into the rewrites at build time AND read at runtime: set the same value for both.
FROM node:24-slim AS build
WORKDIR /app
ARG API_ORIGIN=http://whitepay:3000
ENV API_ORIGIN=$API_ORIGIN NEXT_TELEMETRY_DISABLED=1 NEXT_STANDALONE=1
COPY package.json package-lock.json ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:24-slim
WORKDIR /app
ARG API_ORIGIN=http://whitepay:3000
ENV NODE_ENV=production PORT=3001 HOSTNAME=0.0.0.0 API_ORIGIN=$API_ORIGIN NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:3001/pricing').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
