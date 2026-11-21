# Build stage: bundle to a single file. Runtime stage: no node_modules, no dev tools.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/dist/main.cjs ./main.cjs
USER node
# Secrets and config come from Render env vars at runtime, never from the image:
# MCP_AUTH_TOKEN, GITHUB_TOKEN, ALLOWED_REPOS. Render injects PORT.
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "main.cjs"]
