# syntax=docker/dockerfile:1.7
FROM python:3.12-slim-bookworm

ARG TARGETARCH
ARG OFFICECLI_VERSION=1.0.143
ARG OFFICECLI_SHA256_AMD64=6a29c598a789b57c92c03e560907d3f131a4bd0a068785b1d338a86fc31a58a7
ARG OFFICECLI_SHA256_ARM64=c50298e4698fcd1b15fe1a0f096405ad260b5c84d4440882582d0bba1e57bd49
WORKDIR /app

# Keep only runtime tools required by skills and plugins.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    libreoffice-calc \
    curl \
    libicu72 \
    nodejs \
  && rm -rf /var/lib/apt/lists/*

# OfficeCLI is part of the agent's pinned local toolchain. Verify the release
# before installing it; the runner never downloads binaries at request time.
RUN set -eux; \
  case "${TARGETARCH}" in \
    amd64) \
      OFFICECLI_URL="https://github.com/iOfficeAI/OfficeCLI/releases/download/v${OFFICECLI_VERSION}/officecli-linux-x64"; \
      EXPECTED_SHA="${OFFICECLI_SHA256_AMD64}"; \
      ;; \
    arm64) \
      OFFICECLI_URL="https://github.com/iOfficeAI/OfficeCLI/releases/download/v${OFFICECLI_VERSION}/officecli-linux-arm64"; \
      EXPECTED_SHA="${OFFICECLI_SHA256_ARM64}"; \
      ;; \
    *) echo "Unsupported architecture: ${TARGETARCH}" && exit 1 ;; \
  esac; \
  curl -fsSL "${OFFICECLI_URL}" -o /usr/local/bin/officecli; \
  echo "${EXPECTED_SHA}  /usr/local/bin/officecli" | sha256sum -c -; \
  chmod +x /usr/local/bin/officecli; \
  officecli --version

# Install deps before copying the rest so the layer caches across code changes.
COPY agent/requirements*.txt /app/agent/
RUN --mount=type=cache,target=/root/.cache/pip \
  pip install -r /app/agent/requirements-runtime.txt

COPY agent/ /app/agent/
COPY skills/ /app/skills/
COPY plugins/ /app/plugins/

ENV PYTHONPATH=/app \
    OFFICECLI_SKIP_UPDATE=1 \
    OFFICECLI_NO_AUTO_RESIDENT=1
EXPOSE 8001
CMD ["uvicorn", "agent.main:app", "--host", "0.0.0.0", "--port", "8001"]
