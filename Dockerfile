# syntax=docker/dockerfile:1
# Agent Tag container image: one bundled JavaScript file on the official Bun runtime.
#
#   docker build -t agent-tag .
#   docker run --rm agent-tag --help
#
# See docs/install.md for volumes, secrets, and reaching T3 on the host.

ARG BUN_VERSION=1.3.13

FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY t3.lock.json ./
COPY config/agent-tag.example.json config/slack-manifest.example.json ./config/
ARG AGENT_TAG_VERSION=0.0.0
ARG AGENT_TAG_COMMIT=
RUN bun build src/cli.ts \
      --target=bun \
      --sourcemap=inline \
      --define "AGENT_TAG_BUILD_VERSION=\"${AGENT_TAG_VERSION}\"" \
      --define "AGENT_TAG_BUILD_COMMIT=\"${AGENT_TAG_COMMIT}\"" \
      --outfile /out/agent-tag.js

FROM oven/bun:${BUN_VERSION}-slim
LABEL org.opencontainers.image.source="https://github.com/Dhruv2mars/agent-tag" \
      org.opencontainers.image.description="Self-hosted Slack coworker that delegates work to T3 Code agents"
ENV NODE_ENV=production \
    AGENT_TAG_INSTALL_KIND=container
COPY --from=build /out/agent-tag.js /opt/agent-tag/agent-tag.js
# Agent Tag refuses a data directory that grants group or world access.
RUN mkdir -p /data /config \
 && chown bun:bun /data \
 && chmod 0700 /data
USER bun
WORKDIR /data
VOLUME ["/data"]
ENTRYPOINT ["bun", "/opt/agent-tag/agent-tag.js"]
CMD ["--help"]
