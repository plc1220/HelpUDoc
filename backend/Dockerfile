FROM node:20-alpine AS base

WORKDIR /app

# Local `file:` dependency: install from repo root context (see infra/docker-compose.yml).
COPY packages/contracts /packages/contracts

# Copy dependency manifests first for better layer caching
COPY backend/package*.json ./
COPY backend/tsconfig.json ./

# Install all dependencies (ts-node lives in devDependencies)
RUN npm ci --legacy-peer-deps

# Copy the backend source code
COPY backend/src ./src

# Runtime workspace content is persisted via volume mounts in deploy envs.
# Ensure directory exists even when no seed data is tracked in git.
RUN mkdir -p workspaces

ENV NODE_ENV=production \
    PORT=3000

# Run the TypeScript entrypoint directly with ts-node
CMD ["npx", "ts-node", "--transpile-only", "src/index.ts"]
