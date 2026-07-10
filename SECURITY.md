# Security

## Supported use

HoProxy is designed for one user on one machine. It defaults to `127.0.0.1`, stores HopGPT browser credentials in `.env` with mode `0600`, and keeps conversation state only in memory.

Do not expose HoProxy directly to the internet. HopGPT credentials grant access to the associated institutional account, and the adapted browser protocol was not designed as a multi-tenant API.

## Network controls

- A non-loopback `HOST` requires `HOPROXY_API_KEY`.
- The key may be supplied as `Authorization: Bearer …` or `X-API-Key`.
- Browser requests require an exact origin in `HOPROXY_CORS_ORIGINS`.
- `/token-debug` is unavailable unless `HOPGPT_DEBUG=true`; token administration routes pass through the same API-key gate as other non-health endpoints.
- Request size, rate, concurrency, message, tool, session, and cache limits are configurable.

Use a trusted local reverse proxy with TLS and its own authentication if another device must reach HoProxy. Keep `HOPROXY_API_KEY` distinct from all upstream credentials.

## Credential handling

Never commit `.env`, browser profiles, HAR files, logs containing credentials, or packaged archives. Re-run `bun run extract` if a browser session expires or is suspected to be exposed, then revoke the old session through the institution's account controls when available.

Logs redact known credential, cookie, prompt, tool-argument, and upstream-body fields. Debug output still belongs on a trusted machine.

## Reporting

Report vulnerabilities privately to the repository owner. Include the affected revision, reproduction steps, impact, and any suggested mitigation. Do not include live institutional credentials or account data.
