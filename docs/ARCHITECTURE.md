# Architecture and limitations

HoProxy adapts Anthropic's Messages API to the private protocol used by the HopGPT web application. It is a compatibility layer, not an official HopGPT integration.

## Request path

1. The Express boundary applies origin, authentication, body, rate, concurrency, and shape limits.
2. The request transformer maps model aliases, messages, thinking controls, and tool definitions into HopGPT's browser request.
3. The client sends the chat POST through `node-tls-client` so the bounded request retains the configured browser TLS fingerprint.
4. HopGPT returns a stream ID. HoProxy then uses native `fetch` for the SSE subscription so data is genuinely streamed and cancellable.
5. The response transformer converts text, thinking, usage, and prompt-injected XML tool calls into Anthropic events.
6. Bounded in-memory stores retain upstream conversation IDs and signatures for compatible follow-up turns.

## Known limitations

- HopGPT authentication relies on browser cookies, bearer refresh behavior, Cloudflare, and an undocumented protocol that may change without notice.
- The TLS client exposes completed response bodies. It is suitable for bounded POST/refresh operations, but not SSE. `HOPGPT_STREAMING_TRANSPORT=tls` is intentionally rejected.
- Native fetch and TLS-fingerprinted POSTs can receive different Cloudflare treatment. `/ready?upstream=true` checks reachability but cannot guarantee the next chat subscription will pass.
- Anthropic clients send transcripts while HopGPT owns server-side threads. Explicit `X-Session-Id` is authoritative; transcript fallback is namespaced and ambiguous matches create a new thread, but stateless clients can still lose upstream continuity.
- Tool use is produced by prompt instructions and parsed XML, not native upstream function calling. HoProxy rejects undeclared names and schema-invalid inputs, but malformed or novel model output can still be omitted.
- `count_tokens` is a conservative local estimate because HopGPT does not expose exact backend tokenizers.
- State is process-local and bounded. Restarting HoProxy loses conversation and signature caches.
- No automatic test or readiness probe sends a chat because doing so consumes institutional account quota.

## Failure phases

Structured timing logs identify `validation`, `refresh`, `post_ack`, `stream_subscribe`, `first_byte`, `tool_close`, and `completion`. A failure before `stream_subscribe` returns an HTTP JSON error; a failure after SSE starts must be represented as an SSE error event.
