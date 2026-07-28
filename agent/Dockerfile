# syntax=docker/dockerfile:1.7
FROM python:3.12-slim
WORKDIR /app

# Keep only runtime tools required by skills and plugins.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    libreoffice-calc \
    nodejs \
  && rm -rf /var/lib/apt/lists/*

# Install deps before copying the rest so the layer caches across code changes.
COPY agent/requirements*.txt /app/agent/
RUN --mount=type=cache,target=/root/.cache/pip \
  pip install -r /app/agent/requirements-runtime.txt

COPY agent/ /app/agent/
COPY skills/ /app/skills/
COPY plugins/ /app/plugins/

ENV PYTHONPATH=/app
EXPOSE 8001
CMD ["uvicorn", "agent.main:app", "--host", "0.0.0.0", "--port", "8001"]
