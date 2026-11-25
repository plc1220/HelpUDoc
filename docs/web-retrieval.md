# Web search and URL context

Lumo exposes two agent tools. `web_search` returns ranked URLs, titles and snippets. `url_context` sends up to five pasted or selected URLs to the page reader and returns up to 6,000 characters of extracted text per successful page. The model receives the source URL with each passage. Only retrieved page text contributes to the self-hosted research source check. The agent still needs to check that the passage supports its claim.

| Agent setting | Discovery | Page reading |
| --- | --- | --- |
| `WEB_SEARCH_PROVIDER=websearchfree` | WebSearchFree `POST /search` | WebSearchFree `POST /extract` |
| `WEB_SEARCH_PROVIDER=searxng` | SearXNG `POST /search` | Unavailable |
| `WEB_SEARCH_PROVIDER=gemini` | Gemini grounding | Gemini URL context |
| `WEB_SEARCH_PROVIDER=disabled` | Disabled | Disabled |

Set `WEBSEARCHFREE_BASE_URL` on the agent. The default `WEBSEARCHFREE_SEARCH_BACKEND=searxng` sends discovery requests to the SearXNG engine only. Configure `WSF_SEARX_URL` on WebSearchFree and enable JSON responses on SearXNG. Select `WEBSEARCHFREE_SEARCH_BACKEND=direct` to query DuckDuckGo, Brave and Wikipedia through WebSearchFree. Both modes read a pasted URL directly, without sending the URL or the user's question to a search engine. Standalone SearXNG uses `SEARXNG_BASE_URL` on the agent.

The private model profile defaults to disabled. The Gemini profile defaults to its existing Gemini tools. Changes to these environment settings take effect on agent restart. The self-hosted path uses HTTP and requires no model credentials at the retrieval service. The service contract was checked against [WebSearchFree v0.5.0](https://github.com/drmikecrypto/WebSearchFree/tree/v0.5.0) and the [SearXNG JSON API](https://docs.searxng.org/dev/search_api.html).

For installations that persist skills on a volume, update the research skill as part of rollout. Its tool list needs both `web_search` and `url_context`. Older skills that declare `google_search` retain discovery access through the compatibility alias.

## Fetch service network access

Expose the reader as an internal service. WebSearchFree accepts unauthenticated HTTP requests. Allow incoming requests only from the Lumo agent workload. In the PCAI chart, the agent shares the application pod’s network identity.

Restrict reader egress to DNS, the configured SearXNG service and public HTTP(S). Block metadata endpoints, private networks and internal destinations that use publicly numbered addresses. The agent checks the initial URL and DNS response. The reader resolves the name again and follows redirects, so enforce destination restrictions at the reader. Adapt the namespace, pod labels, ports and CIDRs in the [reader network policy](../infra/web-retrieval/reader-egress.yaml). Verify that the cluster CNI enforces both directions and that other policies do not grant broader access.

Lumo disables WebSearchFree’s on-disk search and extraction caches for its requests. Configure service and proxy log retention separately, since queries and URLs may contain sensitive information.

Set a reader container memory limit and a download limit on decompressed page content at the fetch layer before broad enablement. WebSearchFree v0.5.0 buffers the upstream response before returning extracted text. Lumo’s passage limit applies after extraction.

## Staged rollout

1. Record the deployed agent image digest, current search setting and research skill revision. Deploy the new agent in the test environment with the private profile’s default search setting (`disabled`).
2. Configure the reader and SearXNG, verify their network policies, then enable `websearchfree` on the test agent and restart it. Keep the user’s Internet Search switch off for one chat and verify that neither tool makes a retrieval request.
3. Enable Internet Search. Ask the agent to find the PostgreSQL license. Check the tool trace for `search_snippets`. In a fresh chat, paste `https://www.postgresql.org/about/licence/` and ask what permissions it grants. Check that the first web tool is `url_context`, its result contains `page_text`, and the answer cites that URL.
4. Check an unreadable page. Its URL should appear in `failed_urls`, with no new research source for that page. JavaScript-rendered pages can yield limited text. During the pilot, review tool failures, upstream timeouts, response times and reader memory or restart counts before widening access.

## Rollback

If source attribution is wrong, the reader can reach an unintended destination, or retrieval failures disrupt chats, restore the previous provider setting (`disabled` for the default private profile) and restart the agent. For an isolation failure, also block access to the reader service. Start a fresh chat and verify the private profile can answer normally with web retrieval disabled. If the agent itself regresses, redeploy the recorded image digest and restore the matching research skill revision. This feature introduces no database migration.
