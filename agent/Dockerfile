FROM python:3.12-slim
WORKDIR /app

ARG PYTORCH_CPU_INDEX_URL=https://download.pytorch.org/whl/cpu
ARG PYPI_INDEX_URL=https://pypi.org/simple

# System libs required by mineru/opencv (paper2slides parser)
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    libxcb1 \
    libx11-6 \
    libxext6 \
    libxrender1 \
    libxfixes3 \
    libxi6 \
    libgl1 \
    libglib2.0-0 \
    libsm6 \
  && rm -rf /var/lib/apt/lists/*

# Install deps before copying the rest so the layer caches across code changes.
COPY agent/requirements.txt /app/agent/requirements.txt
RUN PIP_INDEX_URL="${PYTORCH_CPU_INDEX_URL}" \
  PIP_EXTRA_INDEX_URL="${PYPI_INDEX_URL}" \
  pip install --no-cache-dir -r /app/agent/requirements.txt

COPY agent/ /app/agent/
COPY skills/ /app/skills/

EXPOSE 8001
CMD ["uvicorn", "agent.main:app", "--host", "0.0.0.0", "--port", "8001"]
