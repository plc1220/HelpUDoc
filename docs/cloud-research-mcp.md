# Cloud architecture and pricing MCPs

HelpUDoc uses four complementary integrations for architecture research and estimates:

| Server ID | Purpose | Implementation |
| --- | --- | --- |
| `aws-knowledge` | AWS documentation, architecture guidance, service details and regions | Hosted AWS Knowledge MCP |
| `aws-pricing` | Current AWS public prices, pricing attributes and cost reports | AWS Labs Pricing MCP 1.1.1 behind a private FastMCP HTTP proxy |
| `google-developer-knowledge` | Google documentation, service details and architecture guidance | Official Developer Knowledge remote MCP |
| `gcp-cost` | Google Cloud public service catalog, SKUs and current list prices | Official Cloud Billing/Pricing remote MCP (Preview) |

The `gcp-cost` ID is retained for skill compatibility. It now uses delegated Google
OAuth over HTTP, replacing the third-party local executable. Only ten public
catalog/pricing tools are exposed through `allowed_tools`; account billing and
IAM mutation tools are excluded. Explicit empty allowlists expose no tools.

## Local configuration

In `env/local/stack.env`, set:

```dotenv
GOOGLE_DEVELOPER_KNOWLEDGE_PROJECT_ID=sea-ml-hub
GOOGLE_CLOUD_PRICING_PROJECT_ID=sea-ml-hub
AWS_PRICING_REGION=us-east-1
AWS_PRICING_ACCESS_KEY_ID=
AWS_PRICING_SECRET_ACCESS_KEY=
AWS_PRICING_SESSION_TOKEN=
```

Use `AUTH_MODE=oidc` and `VITE_AUTH_MODE=oidc`. Google OAuth scopes must include
`https://www.googleapis.com/auth/cloud-platform`. Users whose existing grants
lack that scope must sign in and consent again. Enable Developer Knowledge and
Cloud Billing APIs in the selected quota project and ensure the caller has the
required access. The project is sent in the `X-goog-user-project` header.

AWS Pricing needs AWS credentials with pricing API read permissions. Supply them
through the dedicated `AWS_PRICING_*` variables, never the MinIO credentials.
Temporary credentials require a session token and renewal when they expire.
The pricing service has no host-published port; the agent uses
`http://helpudoc-aws-pricing-mcp:8000/mcp` on the Compose network.

Rebuild/recreate the agent and pricing service, and recreate the backend when
OAuth settings change. Preserve any deployment-specific Compose override files.

## Verification

Tool discovery alone does not prove access to upstream pricing APIs. Verify:

- Developer Knowledge: `search_documents` returns documentation.
- Google pricing: `list_services`, `list_skus`, and `list_prices` return data.
- AWS pricing: `get_pricing_service_codes` returns service codes with valid credentials.
- AWS Knowledge: `aws___list_regions` returns regions.

For estimates, record region, currency, usage quantities, pricing date and SKU.
Public list prices do not include negotiated discounts or establish actual bills.

References:
- https://awslabs.github.io/mcp/servers/aws-pricing-mcp-server
- https://developers.google.com/knowledge/mcp
- https://docs.cloud.google.com/mcp/supported-products
- https://docs.cloud.google.com/billing/docs/reference/pricing-api/mcp
