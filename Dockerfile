# syntax=docker/dockerfile:1

# Build stage: npm global installs live here so the compiler toolchain used by
# dsh's node-pty dependency does not end up in the runtime image.
FROM node:22-slim AS cli

ARG CLAUDE_CODE_VERSION=2.1.325
ARG DSH_VERSION=0.1.0-rc.6
ARG INSTALL_DSH=1
ARG NPM_REGISTRY=https://registry.npmjs.org

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# node-pty has no Linux prebuild in its published tarball, so node-gyp compiles
# it. Reuse the headers shipped with the official Node image.
ENV npm_config_nodedir=/usr/local

RUN npm install --global --no-fund --no-audit --registry="${NPM_REGISTRY}" \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

# Keep dsh on by default; INSTALL_DSH=0 produces a claude-only image if a future
# dsh release breaks the Linux build.
RUN if [ "${INSTALL_DSH}" = "1" ]; then \
      npm install --global --no-fund --no-audit --registry="${NPM_REGISTRY}" \
        "@deepseek-ai/dsh@${DSH_VERSION}"; \
    fi

FROM node:22-slim

ARG NPM_REGISTRY=https://registry.npmjs.org

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=cli /usr/local/lib/node_modules/ /usr/local/lib/node_modules/

# The Node base image owns /usr/local/bin/node and npm; add only the executor
# commands. claude's npm package always places the native binary at
# bin/claude.exe (an ELF binary on Linux).
RUN test -f /usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe \
    && ln -sf ../lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe /usr/local/bin/claude \
    && if [ -f /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js ]; then \
         chmod 755 /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js; \
         ln -sf ../lib/node_modules/@deepseek-ai/dsh/lib/bin.js /usr/local/bin/dsh; \
       fi

WORKDIR /app
COPY package.json package-lock.json ./
# package-lock.json records npmmirror URLs; replace the registry host so the
# build works with whichever registry the build network can reach.
RUN npm ci --omit=dev --no-fund --no-audit --registry="${NPM_REGISTRY}" \
      --replace-registry-host=always
COPY src ./src
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /app/data /app/logs \
    && chown -R node:node /app

# Container-only defaults. The local Windows flow keeps 127.0.0.1:8080.
ENV NODE_ENV=production \
    HOME=/home/node \
    MCP_BIND=0.0.0.0 \
    MCP_PORT=8080

# Claude Code refuses --dangerously-skip-permissions as root, so run as the
# unprivileged node user.
USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MCP_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/server.js"]