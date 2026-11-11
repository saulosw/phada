FROM node:22-bookworm-slim AS node

FROM ghcr.io/charmbracelet/vhs:v0.10.0
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN sed -i 's/stable/bookworm/g' /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*
