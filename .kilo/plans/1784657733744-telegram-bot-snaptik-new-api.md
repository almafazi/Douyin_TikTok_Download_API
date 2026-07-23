# Plan: Align telegram-bot API client with snaptik-new

## Goal

Make `telegram-bot` call TikTok/Douyin backends the same way `snaptik-new/app/api/tiktok/route.js` does:

- TikTok: hedged race across `f.snaptik.fit`, `f2.snaptik.fit`, `f3.snaptik.fit`
- Auth: `X-API-Key` + `User-Agent: Snaptik/1.0`
- Body: `{ url, proxy: null, impersonate: 'chrome' }`
- Douyin: sequential primary → fallback (`douyin.snaptik.fit` → `douyin2.snaptik.fit`)
- Normalize relative download URLs against the winning base host
- Keep existing bot UX (chat ad gate, miniapp, tunnel/picker keyboards)

**Out of scope:** changing `downloader-bun` / `d.snaptik.fit` server code.

## Current vs target

| Concern | telegram-bot now | snaptik-new target |
|---|---|---|
| Base | single `API_BASE_URL` (`d.snaptik.fit`) | multi-host race / Douyin hosts |
| Auth | none | `X-API-Key` required for TikTok |
| POST body | `{ url }` | TikTok: `{ url, proxy: null, impersonate: 'chrome' }`; Douyin: `{ url }` |
| Headers | `Content-Type` only | + `User-Agent: Snaptik/1.0`, + `X-API-Key` (TikTok) |
| Failover | none (axios retry=0) | Promise.any race (TikTok) / try-catch fallback (Douyin) |
| Relative links | assume absolute | `resolveDownloadUrl(value, winnerBase)` |
| URL allowlist | TikTok only | TikTok + Douyin |
| `/health` | `GET API_BASE_URL/health` | multi-host health probe (new behavior) |
| Slideshow absolute fallback | rebuild with `API_BASE_URL` | prefer absolute URL already in payload; optional winner-base rebuild |

Response schema (`status: tunnel|picker`, `download_link.*`, `photos`, `download_slideshow_link`) stays the same — bot UI handlers already match this.

## Design decisions (locked)

1. **Target surface:** telegram-bot only (not backend).
2. **Shared client module:** one module used by both `bot.js` and `server.js` so chat + miniapp stay identical.
3. **Config via env** (no hardcoded secrets):
   - `API_KEY` (required for TikTok)
   - `TIKTOK_API_BASES` (default `https://f.snaptik.fit,https://f2.snaptik.fit,https://f3.snaptik.fit`)
   - `DOUYIN_API_PRIMARY` (default `https://douyin.snaptik.fit`)
   - `DOUYIN_API_FALLBACK` (default `https://douyin2.snaptik.fit`)
   - `API_TIMEOUT_MS` (default `15000` for metadata; keep longer timeout for file streams)
   - Deprecate primary use of `API_BASE_URL` for metadata; keep only as optional legacy single-host override if `TIKTOK_API_BASES` unset and `API_BASE_URL` set (compat).
4. **Do not send API key on file download GETs** — only on `POST /tiktok`. Download links from response are used as-is (after absolute URL resolution).
5. **Douyin support:** enable in chat URL regex + miniapp prepare validation (parity with snaptik-new).

## Implementation tasks

### 1. Add `telegram-bot/utils/snaptikApi.js`

Port the logic from `snaptik-new/app/api/tiktok/route.js` into a Node-friendly module using existing axios stack where practical (or native fetch).

Exports (suggested):

- `isSupportedMediaUrl(url)` — tiktok.com / douyin.com
- `isDouyinUrl(url)`
- `resolveDownloadUrl(value, base)` — string | array recursive
- `normalizePayload(response, winnerBase)` — absolute-ize `download_link.*` + `download_slideshow` / `download_slideshow_link`
- `fetchTikTokData(url)` — main entry:
  - validate url
  - branch Douyin vs TikTok
  - TikTok: require `API_KEY`; race bases with abort-on-win; timeout per request
  - Douyin: primary then fallback, no API key (match snaptik-new)
  - return normalized JSON payload
- `checkApisHealth()` — lightweight probe of configured bases (for `/stats`)

Implementation notes:

- Mirror snaptik-new abort/race pattern (AbortController / AbortSignal.any if available on Node 18+, else manual abort).
- On all-fail AggregateError: surface first HTTP status/message when available; else throw `BotError`-friendly error.
- Log winner base for debugging (`logger.info({ base, ms }, 'tiktok api winner')`).
- Do **not** log API key.

### 2. Wire `bot.js`

- Remove single-host `apiClient.post('/tiktok', { url })` for metadata path.
- Use `fetchTikTokData(url)` in URL message handler.
- Expand URL regex / validation to include Douyin (`douyin.com`, short forms if any currently used).
- `/stats`: call `checkApisHealth()` and format multi-host status in `messages.stats` (or extend message helper).
- Slideshow fallback that rebuilds `${API_BASE_URL}/download-slideshow?...`:
  - Prefer full URL already present on payload (`download_slideshow_link`).
  - If only encrypted token remains, resolve against **winner base stored on session** (see task 4) or first configured TikTok base — do not hardcode `d.snaptik.fit`.
- Keep stream downloads via absolute URLs from payload (`streamDownload`); no API key on GET.

### 3. Wire `server.js` (miniapp)

- In `POST /miniapp/api/prepare`, replace `apiClient.post('/tiktok', { url })` with `fetchTikTokData(url)`.
- Align `isTikTokUrl` / prepare validation with Douyin support.
- Ensure returned options still built from normalized absolute links.
- Proxy download route continues streaming absolute URLs; no change to option IDs.

### 4. Session payload: preserve winner base (small)

When creating flow session after successful fetch, store:

```js
{
  ...existing,
  payload: normalizedData,
  apiBase: winnerBase // optional but useful for token-only slideshow rebuild
}
```

If `fetchTikTokData` only returns normalized data, either:

- attach non-enumerable/internal field `_apiBase` stripped before user-facing messages, or
- return `{ data, apiBase }` from the client and store both.

Prefer `{ data, apiBase }` return shape for clarity.

### 5. Env + docs

Update:

- `telegram-bot/.env.example` — add `API_KEY`, `TIKTOK_API_BASES`, Douyin hosts, timeout; mark `API_BASE_URL` as legacy/optional.
- `telegram-bot/README.md` env table.
- Local `.env` is operator-owned: document required keys; **do not commit secrets**. Operator must set real `API_KEY` matching snaptik-new production.

### 6. Messages / UX copy

- Invalid URL message: mention Douyin if supported.
- Stats message: show per-host online/offline + configured provider list.
- Errors: map missing `API_KEY` to clear admin-facing log + generic user message.

## Failure modes

| Case | Behavior |
|---|---|
| Missing `API_KEY` on TikTok URL | Fail fast 500-equivalent; log config error; user sees generic API failure |
| All TikTok bases fail | 502-style error; log each host error |
| Douyin primary fails, fallback ok | Success via fallback |
| Relative download path in response | Prefix with winner base |
| Relative path without base | Treat as error / drop link |
| Private/deleted content | Pass through upstream error message when safe |
| Slideshow token-only + no apiBase | Use first `TIKTOK_API_BASES` entry as last resort |

## Files to touch

- `telegram-bot/utils/snaptikApi.js` (**new**)
- `telegram-bot/bot.js`
- `telegram-bot/server.js`
- `telegram-bot/utils/messages.js` (stats + invalid URL if needed)
- `telegram-bot/.env.example`
- `telegram-bot/README.md`

Optional small cleanup: stop constructing unused single-host `apiClient` for metadata if nothing else needs it (keep axios helpers for streaming).

## Validation

1. Unit-ish manual checks against `snaptikApi` helpers:
   - `resolveDownloadUrl` absolute passthrough
   - relative `/download?data=...` → `https://f.snaptik.fit/download?data=...`
   - array photo links
2. Integration (with real `API_KEY`):
   - TikTok video URL → `status: tunnel` + absolute HD/SD/WM/mp3 links openable
   - TikTok photo URL → `status: picker` + photos + slideshow link
   - Douyin URL → success via primary or fallback
   - Invalid URL → 400 path / bot invalid message
   - Kill one f-host (or wrong DNS) → race still succeeds on another
3. Bot flows:
   - paste TikTok link in chat → ad gate → download options work
   - miniapp prepare → options → each option downloads
   - `/stats` shows multi-host health
4. Regression: watermark/no_watermark_hd/mp3/photo_N callback handlers still resolve URLs.

## Rollout

1. Deploy bot with new env vars set (`API_KEY`, bases).
2. Keep old `API_BASE_URL` temporarily unused for metadata (rollback: point `TIKTOK_API_BASES` to single old host if f-cluster broken — note old host may not accept `X-API-Key`/`impersonate`; true rollback is git revert + restore `API_BASE_URL` path).
3. Monitor logs for `tiktok api winner` distribution and error rates.

## Open / non-blocking

- Confirm production `API_KEY` value with operator (same as snaptik-new server env).
- Whether Douyin should appear in help text for all locales (default: yes, short mention).
