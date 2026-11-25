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

Run the reader behind an internal service with public-web egress. Restrict its outgoing connections at the network layer, including redirected requests and new DNS resolutions. Allow DNS, the configured SearXNG service, and public HTTP(S) destinations. Block metadata, private subnets and other internal destinations. The agent validates the initial URL and DNS response. WebSearchFree resolves the target independently and follows redirects. On Kubernetes, apply the [example reader egress policy](../infra/web-retrieval/reader-egress.yaml) to the reader namespace, adapting labels and cluster, service and node CIDRs for the installation. Use a CNI that enforces egress policies and check for other policies that grant broader access.

## Verify the integration

Enable Internet Search and ask a question with a known official source. Check the `web_search` result for `search_snippets`, then ask about the content of a specific link. A successful `url_context` result contains `page_text`. An unreadable URL appears in `failed_urls`. If all reads fail, research receives no new source. Static HTML extraction can return limited text for JavaScript-rendered pages.
