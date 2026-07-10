# HoProxy

**Anthropic-compatible API proxy for HopGPT (`https://chat.ai.jh.edu`).**

Point any Anthropic SDK client — Claude Code, OpenCode, the Python/JS SDKs — at a local endpoint that speaks the Messages API, and HoProxy translates requests to HopGPT under the hood.

HoProxy is a single-user, local adapter for HopGPT's private browser protocol. It is not an official HopGPT API and should not be exposed as a shared or public service. See [Security](SECURITY.md) and [Architecture and limitations](docs/ARCHITECTURE.md).

## Quick Start

Requires **Bun 1.3+**.

```bash
bun install
bun run extract   # opens a browser for one-time HopGPT login
bun run start
```

The proxy listens on `http://127.0.0.1:3001`. If extraction completes without errors, you're done — jump to **[Client Setup](#client-setup)**.

> **Manual credential setup.** If `bun run extract` can't drive a browser on your machine, see [Appendix A: Manual credential setup](#appendix-a-manual-credential-setup).

## Client Setup

### Claude Code

Install Claude Code (`curl -fsSL https://claude.ai/install.sh | bash` or `npm i -g @anthropic-ai/claude-code`), then point it at HoProxy via `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "test",
    "ANTHROPIC_BASE_URL": "http://localhost:3001",
    "ANTHROPIC_MODEL": "claude-sonnet-4-5"
  }
}
```

Restart Claude Code. In the default loopback-only mode, HoProxy ignores the auth token but Claude Code requires a non-empty value. If `HOPROXY_API_KEY` is configured, use that value as `ANTHROPIC_AUTH_TOKEN`. Equivalent shell env vars (`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`) work as well.

### OpenCode

Point OpenCode at `http://localhost:3001` as an Anthropic-compatible provider. HoProxy handles OpenCode's tool-use flow out of the box — it injects tool definitions into the prompt, parses the model's XML tool calls, and returns standard Anthropic `tool_use` blocks. Tool streams are closed as soon as a complete tool-call batch is emitted, or after a short idle window once a tool call has streamed, so OpenCode can run tools immediately instead of waiting for HopGPT to finish extra narration. If your client parses XML tool calls directly from the text stream instead, see [Appendix B: MCP passthrough mode](#appendix-b-mcp-passthrough-mode).

### Pi Agent

Register HoProxy as a Pi custom provider in `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "hoproxy": {
      "baseUrl": "http://localhost:3001",
      "api": "anthropic-messages",
      "apiKey": "dummy",
      "compat": {
        "supportsEagerToolInputStreaming": false,
        "supportsLongCacheRetention": false,
        "supportsCacheControlOnTools": false
      },
      "models": [
        {
          "id": "gpt-5.5",
          "name": "HoProxy GPT 5.5",
          "reasoning": true,
          "thinkingLevelMap": {
            "off": null,
            "minimal": null,
            "low": null,
            "medium": null,
            "high": null,
            "xhigh": "xhigh"
          },
          "compat": {
            "forceAdaptiveThinking": true
          },
          "input": ["text", "image"],
          "contextWindow": 400000,
          "maxTokens": 128000
        },
        {
          "id": "claude-opus-4-5",
          "name": "HoProxy Claude Opus 4.5",
          "reasoning": true,
          "thinkingLevelMap": {
            "off": null,
            "minimal": null,
            "low": null,
            "medium": null,
            "high": null,
            "xhigh": "max"
          },
          "input": ["text", "image"],
          "contextWindow": 200000,
          "maxTokens": 32000
        }
      ]
    }
  }
}
```

Then set Pi's project defaults in `.pi/settings.json`:

```json
{
  "defaultProvider": "hoproxy",
  "defaultModel": "gpt-5.5",
  "defaultThinkingLevel": "xhigh",
  "thinkingBudgets": {
    "high": 32000
  }
}
```

Start HoProxy with `bun run start`, then run `pi` from the project directory. With the default local-only configuration, HoProxy ignores the dummy API key; Pi only needs a non-empty provider credential so it can send Anthropic Messages requests to the local proxy.

This exposes only GPT 5.5 with Pi `xhigh` thinking and Claude Opus 4.5 with Pi `xhigh` mapped to the deepest supported budget-style thinking. A quick smoke test is:

```bash
pi --provider hoproxy --model gpt-5.5 --thinking xhigh --no-tools --no-session -p "Reply with exactly: HoProxy Pi test OK"
pi --provider hoproxy --model claude-opus-4-5 --thinking xhigh --no-tools --no-session -p "Reply with exactly: HoProxy Pi test OK"
```

### Anthropic SDK

Python:

```python
from anthropic import Anthropic

client = Anthropic(api_key="dummy", base_url="http://localhost:3001")
msg = client.messages.create(
    model="claude-sonnet-4-5",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}],
)
print(msg.content)
```

JavaScript:

```javascript
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: 'dummy', baseURL: 'http://localhost:3001' });
const msg = await client.messages.create({
  model: 'claude-sonnet-4-5',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello!' }],
});
console.log(msg.content);
```

curl (streaming):

```bash
curl http://localhost:3001/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 1024,
    "stream": true,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

## Models

| Canonical ID          | Use case                                            |
| --------------------- | --------------------------------------------------- |
| `gpt-5-5`             | OpenAI reasoning model (HopGPT AzureOpenAI endpoint).|
| `claude-opus-4-5`     | Highest quality; complex reasoning, long-form work. |
| `claude-sonnet-4-5`   | Balanced speed/quality; good default.               |
| `claude-haiku-4-5`    | Fastest; low-latency tasks.                         |

The proxy also accepts `gpt-5.5`, dotted Claude variants (`claude-sonnet-4.5`), provider-prefixed IDs (`anthropic/…`), dated/stable suffixes, and `-thinking` suffixes (`claude-sonnet-4-5-thinking`). The `-thinking` form never appears in canonical responses — thinking mode is enabled internally based on the model.

For Claude models, HoProxy forwards Anthropic sampling controls (`temperature`, `top_p`, and `top_k`) to HopGPT when they are numeric.

**GPT-5.5** runs on HopGPT's AzureOpenAI endpoint, which serves a reasoning model with a fixed parameter set. HoProxy reshapes the request into the exact wire form the chat.ai.jh.edu web client sends: it strips Anthropic-style sampling controls (`temperature`, `top_p`, `top_k`, `frequency_penalty`, `presence_penalty`), the Bedrock `thinking` budget object, and `ephemeralAgent` (none of which the reasoning model accepts), and pins `reasoning_effort: "xhigh"`, `reasoning_summary: "detailed"`, `imageDetail: "high"`, and `resendFiles: false`. Omitted sampling params fall back to HopGPT's server defaults (Temperature 1.0, Top P 1.0, penalties 0, Verbosity none, Responses API off). See `src/transformers/azureOpenAIDefaults.js`.

When thinking is enabled, HoProxy floors the request's `max_tokens` at 8192 before forwarding to HopGPT. HopGPT's Bedrock backend rejects requests where `max_tokens <= thinking.budget_tokens`; bumping the floor keeps the request valid regardless of the caller's budget.

## API

| Endpoint                      | Method | Purpose                                            |
| ----------------------------- | ------ | -------------------------------------------------- |
| `/v1/messages`                | POST   | Anthropic Messages API (streaming + non-streaming) |
| `/v1/messages/count_tokens`   | POST   | Conservative local input-token estimate            |
| `/v1/models`                  | GET    | List available models                              |
| `/v1/models/:id`              | GET    | Fetch one model                                    |
| `/refresh-token`              | POST   | Force a HopGPT token refresh                       |
| `/token-status`               | GET    | Token expiry summary                               |
| `/token-debug`                | GET    | Detailed diagnostics; requires `HOPGPT_DEBUG=true` |
| `/health`                     | GET    | Process liveness                                   |
| `/ready`                      | GET    | Configuration/token readiness                      |

`count_tokens` returns the Anthropic-compatible `{ "input_tokens": number }` shape, but it is an intentionally conservative local estimate. HopGPT does not expose the exact tokenizer used by every backend, so do not use this estimate for billing.

## Configuration

### Environment variables

Core server and access controls:

- `HOST` defaults to `127.0.0.1`; any non-loopback value is rejected unless `HOPROXY_API_KEY` is set.
- `PORT` defaults to `3001`.
- `HOPROXY_API_KEY` enables constant-time bearer or `X-API-Key` authentication.
- `HOPROXY_CORS_ORIGINS` is a comma-separated browser-origin allowlist. Browser origins are denied by default; non-browser clients do not send `Origin`.
- `HOPROXY_BODY_LIMIT` defaults to `10mb`.
- `HOPROXY_MAX_CONCURRENT_MESSAGES`, `HOPROXY_RATE_LIMIT_REQUESTS`, and `HOPROXY_RATE_LIMIT_WINDOW_MS` default to `8`, `120`, and `60000`.
- `HOPROXY_MAX_MESSAGES`, `HOPROXY_MAX_TOOLS`, and `HOPROXY_MAX_SESSION_ID_LENGTH` default to `1000`, `128`, and `256`.

HopGPT credentials:

- `HOPGPT_COOKIE_CONNECT_SID` and `HOPGPT_COOKIE_OPENID_USER_ID` are the normal refresh credentials for current HopGPT sessions.
- `HOPGPT_COOKIE_REFRESH_TOKEN` is a legacy/fallback refresh-token cookie when HopGPT supplies one.
- `HOPGPT_BEARER_TOKEN` is the short-lived JWT bearer and is refreshed automatically.
- `HOPGPT_COOKIE_CF_CLEARANCE`, `HOPGPT_COOKIE_CF_BM`, and `HOPGPT_USER_AGENT` preserve browser/Cloudflare context.
- `HOPGPT_COOKIE_TOKEN_PROVIDER` defaults to `openid`.

Streaming and state:

- Streaming always uses native `fetch`. Setting `HOPGPT_STREAMING_TRANSPORT=tls` now produces an explicit error because the TLS client buffers the complete body and cannot provide real SSE or cancellation.
- `HOPROXY_UPSTREAM_CONNECT_TIMEOUT_MS`, `HOPROXY_UPSTREAM_IDLE_TIMEOUT_MS`, and `HOPROXY_UPSTREAM_TOTAL_TIMEOUT_MS` default to `30000`, `120000`, and `900000`.
- `HOPGPT_TOOL_BATCH_IDLE_CLOSE_MS` defaults to `500`. Complete wrappers/final events close deterministically; this settle window is only the fallback for incomplete streamed wrappers.
- `CONVERSATION_TTL_MS`, `HOPROXY_MAX_SESSIONS`, and `TRANSCRIPT_ALIASES_PER_SESSION` default to 6 hours, `1000`, and `32`.
- `SIGNATURE_CACHE_TTL_MS`, `HOPROXY_MAX_SIGNATURE_ENTRIES`, and `HOPROXY_MAX_SIGNATURE_LENGTH` default to 2 hours, `2000`, and `32768`.
- `HOPROXY_TRUST_CLIENT_CONVERSATION_STATE=true` restores the legacy behavior of accepting unsafely supplied upstream state. By default, client state must match server-owned session state.

Diagnostics:

- `HOPGPT_DEBUG=true` enables debug logging and `/token-debug`.
- `HOPROXY_READY_UPSTREAM_CHECK=true` adds a lightweight reachability check to `/ready`; `GET /ready?upstream=true` enables it for one request.
- `HOPGPT_LOG_LEVEL` defaults to `info`; accepted values are `debug`, `info`, `warn`, `error`, and `silent`.
- `HOPGPT_LOG_NO_COLOR` or `NO_COLOR` disables ANSI color.

Extraction-only: `HOPGPT_PUPPETEER_CHANNEL`, `HOPGPT_PUPPETEER_USER_DATA_DIR`.

With auto-refresh on, the normal minimum is `HOPGPT_COOKIE_CONNECT_SID` plus `HOPGPT_COOKIE_OPENID_USER_ID`. When HopGPT also provides `HOPGPT_COOKIE_REFRESH_TOKEN`, HoProxy sends it with refresh requests so bearer tokens can continue renewing after the server-side OpenID session token cache is no longer available.

### Authentication

HoProxy handles two refresh scopes:

- **Bearer token** (~75 min lifespan). Auto-refreshed before expiry by calling HopGPT's `/api/auth/refresh` with the same empty-body request shape the browser uses; if HopGPT still returns 401/403, HoProxy refreshes once and retries the failed request phase.
- **Browser session cookies** (`connect.sid` plus `openid_user_id`). Current HopGPT sessions use this browser cookie context to mint bearer tokens. When either cookie expires or is rejected, run `bun run extract` to re-authenticate.
- **`refreshToken` cookie**. OpenID refresh first uses the server-side session behind `connect.sid`, then falls back to this cookie when present. That fallback is what should keep bearer tokens renewing until the refresh token expires, commonly around a week.

During extraction, HoProxy validates the browser session by making a real in-browser refresh before writing `.env`. The `connect.sid`, `openid_user_id`, optional `refreshToken`, and `token_provider` cookies can rotate server-side on refresh and are tracked together; Cloudflare cookies are best-effort and may need re-extraction on blocks.

### Conversation state

HoProxy keeps HopGPT conversation threading in memory so multi-turn calls reuse context:

- Pass a stable session key via the `X-Session-Id` request header or any of `metadata.{session_id,sessionId,conversation_id,conversationId}`.
- Omit it and the proxy generates a key, echoed back as `X-Session-Id` on the response. If your client does not return that key, HoProxy matches follow-up requests by their transcript prefix. Transcript aliases are namespaced by `X-HoProxy-Client-Id`, or by a stable network/client fingerprint when the header is absent; ambiguous matches start a new isolated session.
- Reset a conversation with `X-Conversation-Reset: true` or `metadata.{conversation_reset,reset,new_conversation}`.

State expires after `CONVERSATION_TTL_MS` (6h default).

## Troubleshooting

| Symptom                                         | Fix                                                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Connection refused                              | Proxy isn't running. `bun run start`.                                                                                  |
| `authentication_error` from HoProxy             | Re-run `bun run extract`, then restart the server.                                                                     |
| Refresh logs show missing refresh credentials   | Session cookies are missing or stale. Re-run `bun run extract`, then restart.                                          |
| 401/403 from HopGPT                             | Refresh credentials expired or were rejected. Re-run `bun run extract`.                                               |
| Cloudflare "Attention Required" page            | CF cookies or UA are stale. Re-run `bun run extract` and restart.                                                      |
| Streaming setup fails before any SSE event      | Check `post_ack` and `stream_subscribe` phase logs. Native fetch may be blocked even when the TLS-fingerprinted POST succeeds. TLS streaming fallback is intentionally unsupported because it buffers. |
| Stream stalls after starting                    | Check `first_byte`, idle-timeout, and total-timeout logs; increase the corresponding `HOPROXY_UPSTREAM_*_TIMEOUT_MS` only after identifying the slow phase. |
| Model warning / not found                       | Use a canonical model from the table above, or hit `GET /v1/models`.                                                   |
| Claude Code still calls `api.anthropic.com`     | `ANTHROPIC_BASE_URL` isn't being read. Double-check `~/.claude/settings.json` and restart Claude Code.                 |
| Tool-call XML rendered as text                  | Passthrough mode is on. See [Appendix B](#appendix-b-mcp-passthrough-mode) — the default (off) converts XML to `tool_use`. |
| Agent stops after tool results or `continue`    | Upgrade to a build with continuation fixes: forced-closed streams no longer store HopGPT's user-message id as the assistant parent, tool-result turns replay the matching `tool_use`, stateless clients avoid shared derived sessions, and OpenCode tool streams end immediately after each tool batch. |

Need deeper insight? `HOPGPT_DEBUG=true bun run start` logs incoming HopGPT events, detected tool-call XML, parsed tool calls, and phase timings. `GET /token-debug` compares in-memory auth state against `.env`.

## Streaming protocol

HopGPT uses a two-phase chat protocol. HoProxy makes the bounded POST through the TLS-fingerprinted client to get a `{streamId, conversationId, status:"started"}` ack, then subscribes to `/api/agents/chat/stream/{streamId}` with native `fetch`. No Anthropic SSE bytes are sent until the subscription succeeds, so setup failures retain their HTTP status and JSON error shape. Retry policy splits by phase: POST 401/403/429 fully re-runs the sequence; GET 401/403/429 retries the subscription only (reusing the same `streamId`) to avoid duplicating the user's persisted message.

The outgoing Anthropic stream keeps strict block shape for SDK clients: `tool_use` block starts include `input: {}` before `input_json_delta` chunks, thinking blocks emit `signature_delta` before `content_block_stop` when HopGPT provides a signature, and tool-use responses end with `stop_reason:"tool_use"` as soon as a complete tool-call batch has been transformed. Undeclared tools and inputs that remain invalid after conservative schema coercion are rejected. Incomplete `<function_calls>` wrappers use the configurable settle window and reset it on every tool delta.

## Testing

```bash
bun run test        # run once
bun run test:watch  # watch mode
bun run test:coverage
```

## Code quality

```bash
bun run lint          # run Biome lint rules
bun run format        # write formatter changes
bun run format:check  # check formatting without writing
bun run check         # apply safe Biome fixes
bun run audit         # dependency advisories
bun run pack:dry-run  # inspect package contents
```

The test suite never makes a live HopGPT chat request. A live smoke test consumes institutional account quota and is therefore opt-in:

```bash
curl --fail-with-body http://127.0.0.1:3001/v1/messages \
  -H 'content-type: application/json' \
  -d '{"model":"claude-haiku-4-5","max_tokens":8,"messages":[{"role":"user","content":"Reply OK"}]}'
```

## Project Structure

```
src/
├── index.js                    # CLI listener and graceful shutdown
├── app.js                      # Import-safe Express application factory
├── config.js                   # Validated runtime configuration
├── extract-credentials.js      # Optional browser credential extraction
├── messageValidation.js        # Bounded Anthropic request validation
├── errors/authErrors.js        # Auth error classes
├── routes/
│   ├── messages.js             # /v1/messages (+ count_tokens)
│   ├── models.js               # /v1/models
│   └── refreshToken.js         # /refresh-token, /token-status, /token-debug
├── transformers/
│   ├── anthropicToHopGPT.js    # Request translation
│   ├── hopGPTToAnthropic.js    # SSE response translation
│   ├── toolCallParser.js       # Structured tool-call parsing
│   ├── toolInput.js            # Schema coercion and validation
│   ├── textSanitizer.js        # Prompt-leak and role sanitization
│   ├── streamState.js          # Response stream state defaults
│   ├── signatureCache.js       # Tool signature cache
│   └── thinkingUtils.js        # Thinking-block helpers
├── services/
│   ├── browserCredentials.js   # Browser credential helpers
│   ├── activeStreams.js        # Shutdown-aware stream registry
│   ├── conversationStore.js    # In-memory session store
│   ├── hopgptClient.js         # HopGPT API client
│   └── tlsClient.js            # TLS-fingerprinted requests
└── utils/
    ├── logger.js               # Logging
    ├── modelMapping.js         # Model alias resolution
    ├── requestTimings.js       # Redacted protocol phase timings
    ├── tokenEstimate.js        # Conservative token estimate
    └── sseParser.js            # Cancellable SSE parsing/backpressure
```

## License

MIT

---

## Appendix A: Manual credential setup

If Puppeteer can't drive a browser on your host, grab the values yourself:

1. Open `https://chat.ai.jh.edu` and log in.
2. DevTools (F12) → Network → send any message.
3. Inspect the request to `/api/agents/chat/AnthropicClaude` and copy:

```bash
# .env — minimum
HOPGPT_COOKIE_CONNECT_SID=s%3A...
HOPGPT_COOKIE_OPENID_USER_ID=eyJhbGciOiJIUzI1NiIs...

# recommended (otherwise auto-populated on first request)
HOPGPT_BEARER_TOKEN=eyJhbGciOiJIUzI1NiIs...
HOPGPT_COOKIE_CF_CLEARANCE=...
HOPGPT_COOKIE_CF_BM=...
HOPGPT_COOKIE_TOKEN_PROVIDER=openid
HOPGPT_USER_AGENT="Mozilla/5.0 ..."

# legacy, only if present in your HopGPT cookies
HOPGPT_COOKIE_REFRESH_TOKEN=...
```

## Appendix B: MCP passthrough mode

Default behavior: HoProxy parses the model's tool-call XML (MCP, `function_calls`, `antml:function_calls`, or `tool_call` JSON wrappers) and emits Anthropic `tool_use` blocks. This is what Claude Code, OpenCode, and the Anthropic SDKs expect.

Passthrough leaves the raw XML in the response text so your client can parse it directly. Enable per-request:

```bash
# HTTP header
curl -H "x-mcp-passthrough: true" ...

# or metadata
{ "metadata": { "mcp_passthrough": true }, "messages": [...] }
```

Supported tool-call XML formats (auto-detected in default mode):

<details>
<summary>Show XML format examples</summary>

**MCP tool call:**

```xml
<mcp_tool_call>
<server_name>opencode</server_name>
<tool_name>Edit</tool_name>
<arguments>{"file_path": "example.ts", "new_string": "..."}</arguments>
</mcp_tool_call>
```

**OpenCode `function_calls`:**

```xml
<function_calls>
<invoke name="Glob">
<parameter name="pattern">**/*.ts</parameter>
</invoke>
</function_calls>
```

**Claude Code `antml:function_calls`:** same shape, `antml:` prefix on `function_calls` / `invoke` / `parameter`.

**Tool-call JSON wrapper:**

```xml
<tool_call>
{"name": "Task", "parameters": {"task": "Explore the codebase", "agent": "explorer"}}
</tool_call>
```

</details>
