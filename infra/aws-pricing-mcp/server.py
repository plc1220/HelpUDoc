"""Serve the AWS Labs pricing STDIO server on the private Compose network."""

import os

from fastmcp.server.providers.proxy import FastMCPProxy, ProxyClient


credentials = {
    key: os.environ[key]
    for key in (
        "AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN", "AWS_EC2_METADATA_DISABLED",
    )
    if os.environ.get(key)
}
credentials["FASTMCP_LOG_LEVEL"] = "ERROR"

upstream = {
    "mcpServers": {
        "pricing": {
            "command": "awslabs.aws-pricing-mcp-server",
            "env": credentials,
        },
    },
}
proxy = FastMCPProxy(
    client_factory=lambda: ProxyClient(upstream),
    name="AWS Pricing",
    provider_error_strategy="raise",
)

if __name__ == "__main__":
    proxy.run(transport="http", host="0.0.0.0", port=8000, path="/mcp")
