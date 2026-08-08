# syntax=docker/dockerfile:1
# office-service: wraps iOfficeAI/OfficeCLI behind an internal HTTP API.
# Build context is the repository root.

FROM python:3.13-slim-bookworm AS base

ARG TARGETARCH
ARG OFFICECLI_VERSION=1.0.143
ARG OFFICECLI_SHA256_AMD64=6a29c598a789b57c92c03e560907d3f131a4bd0a068785b1d338a86fc31a58a7
ARG OFFICECLI_SHA256_ARM64=c50298e4698fcd1b15fe1a0f096405ad260b5c84d4440882582d0bba1e57bd49

# ICU runtime required for .NET globalization (OfficeCLI)
RUN apt-get update && apt-get install -y --no-install-recommends curl libicu72 && \
    rm -rf /var/lib/apt/lists/*

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
    chmod +x /usr/local/bin/officecli

WORKDIR /app
COPY office-service/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY office-service/app.py office-service/config.py office-service/executor.py \
     office-service/models.py office-service/security.py ./

# OfficeCLI upstream license/notice files (Apache 2.0 compliance)
COPY office-service/licenses/ /app/licenses/

ENV HOME=/tmp/officecli-home \
    OFFICECLI_SKIP_UPDATE=1 \
    OFFICECLI_NO_AUTO_RESIDENT=1 \
    PYTHONUNBUFFERED=1

EXPOSE 8002
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8002", "--workers", "1"]
