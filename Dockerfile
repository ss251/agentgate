FROM oven/bun:1.3.3

WORKDIR /app

# Copy package files
COPY package.json bun.lock* ./
COPY packages/core/package.json packages/core/
COPY packages/middleware/package.json packages/middleware/
COPY packages/sdk/package.json packages/sdk/
COPY apps/gateway/package.json apps/gateway/

# Install deps
RUN bun install --frozen-lockfile || bun install

# Copy source
COPY . .

# Build packages
RUN cd packages/core && bun run build || true
RUN cd packages/middleware && bun run build || true
RUN cd packages/sdk && bun run build || true

EXPOSE 3402
ENV PORT=3402

CMD ["bun", "run", "apps/gateway/src/index.ts"]
