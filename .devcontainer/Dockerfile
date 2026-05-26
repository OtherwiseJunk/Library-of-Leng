FROM mcr.microsoft.com/devcontainers/javascript-node:1-20-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip postgresql-client \
  && rm -rf /var/lib/apt/lists/*

USER node

WORKDIR /workspaces/library-of-leng
