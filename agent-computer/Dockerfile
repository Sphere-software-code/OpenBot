# The Bot's computer installs only the Playwright browser it launches.
#
# The image tag and Playwright dependency must be pinned to the same exact version. Bump both or
# neither.
FROM node:24.18.1-bookworm-slim AS node-toolchain
# At least 1.4: under 1.3.14 Playwright's `connectOverCDP` never completes its WebSocket handshake
# (the server answers 101 and Bun does not hand the upgrade over), and the kernel backend is that call.
FROM oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598 AS bun-toolchain

FROM ubuntu:24.04

# The Bun image digest pins the amd64/arm64 release bytes, including if its tag changes.
ARG PLAYWRIGHT_VERSION=1.62.1
ENV BUN_INSTALL=/usr/local
ENV PATH="/usr/local/bin:${PATH}"
ENV DEBIAN_FRONTEND=noninteractive
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=node-toolchain /usr/local /usr/local
COPY --from=bun-toolchain /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip xz-utils \
  && ln -s bun /usr/local/bin/bunx \
  && bunx --bun "playwright@${PLAYWRIGHT_VERSION}" install --with-deps chromium \
  && rm -rf /root/.cache /tmp/* /var/lib/apt/lists/*

WORKDIR /app
# The lockfile as well as the manifest: `--frozen-lockfile` with no lockfile present resolves afresh
# and exits 0, so the file has to be here for the flag to mean anything.
COPY agent-computer/package.json agent-computer/bun.lock ./
RUN bun install --frozen-lockfile

COPY agent-computer/src ./src
# index.ts imports ../../shared/file-download at runtime (the other shared imports are type-only and
# erased), so the one file it needs goes where that path resolves from /app/src.
COPY shared/file-download.ts /shared/file-download.ts

# Durable working directory. Bot-produced files that must survive replacement live here.
RUN mkdir -p /workspace
ENV WORKSPACE_DIR=/workspace

# Which browser this computer drives: `managed` starts Chromium here, `kernel` attaches over CDP to a
# kernel container per Bot (see src/browser-runtime.ts). Chosen at build time because the supervisor
# forwards a fixed set of settings to the computers it creates, and this is not one of them.
ARG COMPUTER_BROWSER_BACKEND=managed
ENV COMPUTER_BROWSER_BACKEND=${COMPUTER_BROWSER_BACKEND}

ENV PORT=4100
EXPOSE 4100
# Readiness is exposed through Docker health so the supervisor need not know the network route.
# Every second until it first answers, then every 30 s: each probe is an exec, and readiness is the
# only question asked of it. COMPUTER_HEALTHCHECK in supervisor/src/docker.ts states the same.
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --start-interval=1s --retries=3 \
  CMD bun -e "const r = await fetch('http://localhost:4100/health'); process.exit(r.ok ? 0 : 1)"

CMD ["bun", "src/index.ts"]
