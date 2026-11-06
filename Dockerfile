# WhitePay server. Node 24 is required (node:sqlite).
# Stage 1 compiles the contracts (the server reads their ABIs from artifacts/); stage 2 is the slim runtime image.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json hardhat.config.js ./
RUN npm install --no-audit --no-fund
COPY contracts ./contracts
RUN npx hardhat compile

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=data PORT=3000
COPY package.json package-lock.json ./
# Runtime needs only express, ethers and dotenv; Hardhat stays in the build stage.
RUN npm install --omit=dev --no-audit --no-fund
COPY server ./server
COPY docs/openapi.json ./docs/openapi.json
COPY cli ./cli
COPY mcp ./mcp
COPY --from=build /app/artifacts/contracts ./artifacts/contracts
# deployment.json (contract addresses) lives in the mounted data volume.
RUN mkdir -p data && chown -R node:node /app
VOLUME ["/app/data"]
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
