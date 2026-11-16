FROM python:3.12-slim
RUN pip install --no-cache-dir fastmcp==4.0.9 uv==0.12.19 \
    && uv tool install awslabs.aws-pricing-mcp-server==1.1.1
ENV PATH="/root/.local/bin:${PATH}"
WORKDIR /app
COPY server.py /app/server.py
EXPOSE 8000
CMD ["python", "/app/server.py"]
