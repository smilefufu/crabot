# Scrapling MCP Server (Crabot: 0.4.15 / Python MCP 2.3.0)

The runtime exposes thirteen upstream tools. Read the live tool schema for complete parameters and defaults. Scraping responses contain `status`, `content` (a list of strings), and `url`; bulk calls return lists. Session and screenshot tools have their own response types.

| Tool | Purpose |
|---|---|
| `make_request` | One HTTP request; `method` defaults to `GET`, also supports POST/PUT/PATCH/DELETE/HEAD/OPTIONS |
| `bulk_get` | Concurrent one-shot HTTP GET requests (`urls`) |
| `fetch` | One-shot JavaScript browser fetch |
| `bulk_fetch` | Concurrent one-shot browser fetches (`urls`) |
| `stealthy_fetch` | One-shot stealth browser fetch |
| `bulk_stealthy_fetch` | Concurrent one-shot stealth browser fetches (`urls`) |
| `open_session` | Open a `dynamic` or `stealthy` browser session |
| `open_request_session` | Open a persistent HTTP request session |
| `session_fetch` | Fetch a page using a browser `session_id` |
| `session_make_request` | Make an HTTP request using a request `session_id` |
| `screenshot` | Capture an image using an existing browser `session_id` |
| `list_sessions` | List sessions and their effective settings |
| `close_session` | Close any session and release its resources |

## Select and extract

Start with `make_request` for static content; use `fetch` for JavaScript and `stealthy_fetch` when the site needs stealth. Use bulk tools for parallel one-shot requests. Common extraction options are `extraction_type` (`markdown`, `html`, `text`), `css_selector`, and `main_content_only` (default true). Narrow content with a selector when possible. Browser timeouts are milliseconds; HTTP timeouts are seconds. Refer to each live schema before changing defaults.

## Sessions

Browser sessions store browser-level configuration such as `headless`, `proxy`, `cookies`, and optional `cdp_url`. Per-page options belong to `session_fetch`; a browser session accepts either dynamic or stealthy fetching according to its type. HTTP sessions use `open_request_session` + `session_make_request`, retaining cookies and connections. Supply HTTP method/body on each request as needed.

```text
open_session(session_type="dynamic") -> session_id
session_fetch(session_id=..., url="https://example.com")
screenshot(session_id=..., url="https://example.com", image_type="png")
close_session(session_id=...)

open_request_session() -> session_id
session_make_request(session_id=..., url="https://example.com", method="GET")
close_session(session_id=...)
```

One-shot tools never reuse sessions and do not accept `session_id`. `screenshot` returns image and URL content blocks and requires a browser session; `quality` applies only to JPEG. Always close sessions when finished. Session IDs cease to exist after the MCP process restarts.

## Crabot deployment

Installation/upgrade prepares the pinned product runtime. MCP startup consumes it without pip, global PATH lookup, or browser downloads. System deployments share read-only product resources; each instance owns its temporary browser profiles/cache. The Agent's task Python environment is separate.

Local browser tools default to headless and run independently of Admin's Chrome. System mode and Linux without DISPLAY/Wayland reject local `headless=false`. An explicitly supplied `cdp_url` retains upstream remote browser behavior; no local CDP endpoint is injected and login state inheritance is not guaranteed.
