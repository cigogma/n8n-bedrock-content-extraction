# Multi-stage Dockerfile to build TypeScript custom node and run with n8n

FROM node:18-bullseye AS builder
WORKDIR /app

# Install deps (use package-lock if present)
COPY package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

# Copy source and build (try package build script, fallback to tsc)
COPY . .
RUN npm run build || npx tsc --project tsconfig.json --outDir build

FROM n8nio/n8n:latest
USER root

# Ensure custom nodes dir exists
RUN mkdir -p /home/node/.n8n/nodes

# Copy built nodes (adjust path if your build outputs elsewhere)
COPY --from=builder /app/build/nodes /home/node/.n8n/nodes

# If your custom nodes need their own node_modules, copy them too
COPY --from=builder /app/node_modules /home/node/.n8n/nodes/node_modules

RUN chown -R node:node /home/node/.n8n
USER node

ENV NODE_ENV=production
EXPOSE 5678

CMD ["n8n"]
