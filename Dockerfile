# Build context must be the monorepo root (proyect/) so both
# Signalix-contracts and Signalix-realtime are available.
# docker build -f Signalix-realtime/Dockerfile -t signalix-realtime .

FROM node:22-alpine AS builder

WORKDIR /workspace

# --- contracts ---
COPY Signalix-contracts/package*.json ./Signalix-contracts/
RUN cd Signalix-contracts && npm ci

COPY Signalix-contracts/ ./Signalix-contracts/
RUN cd Signalix-contracts && npm run build

# --- realtime ---
COPY Signalix-realtime/package*.json ./Signalix-realtime/
RUN cd Signalix-realtime && npm ci

COPY Signalix-realtime/tsconfig.json ./Signalix-realtime/
COPY Signalix-realtime/src ./Signalix-realtime/src
RUN cd Signalix-realtime && npm run build

# Prune dev deps, then replace the file: symlink with the compiled dist so
# the runtime image does not need the contracts source tree.
RUN cd Signalix-realtime && npm prune --omit=dev
RUN rm -f /workspace/Signalix-realtime/node_modules/@signalix/contracts \
 && mkdir -p /workspace/Signalix-realtime/node_modules/@signalix/contracts \
 && cp /workspace/Signalix-contracts/package.json \
       /workspace/Signalix-realtime/node_modules/@signalix/contracts/ \
 && cp -r /workspace/Signalix-contracts/dist \
          /workspace/Signalix-realtime/node_modules/@signalix/contracts/dist

# --- runtime ---
FROM node:22-alpine

WORKDIR /app

COPY --from=builder /workspace/Signalix-realtime/node_modules ./node_modules
COPY --from=builder /workspace/Signalix-realtime/dist ./dist
COPY --from=builder /workspace/Signalix-realtime/package.json ./package.json

EXPOSE 5000

CMD ["node", "dist/server.js"]
