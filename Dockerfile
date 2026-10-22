# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24-bookworm
ARG DOCKER_CLI_IMAGE=docker:29-cli
FROM ${DOCKER_CLI_IMAGE} AS docker-cli
FROM ${NODE_IMAGE}
ARG CODEX_VERSION=latest
ARG CLAUDE_CODE_VERSION=latest
RUN apt-get update \
    && apt-get install -y --no-install-recommends git openssh-client ca-certificates python3 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global "@openai/codex@${CODEX_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/
WORKDIR /opt/ardai
COPY package.json config.json brand.json orchestrator.mjs LICENSE AGENT_PROTOCOL.md ./
COPY lib/ ./lib/
COPY hooks/ ./hooks/
COPY docker/ ./docker/
RUN chmod +x orchestrator.mjs docker/git-askpass.mjs \
    && npm install --global /opt/ardai \
    && codex --version && claude --version && docker compose version
ENV HOME=/home/node GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/opt/ardai/docker/git-askpass.mjs
USER node
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/ardai/docker/entrypoint.mjs"]
CMD ["serve", "--no-open"]
