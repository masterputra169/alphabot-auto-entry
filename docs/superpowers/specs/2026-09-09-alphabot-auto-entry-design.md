# Alphabot Auto Entry — Design

**Date:** 2026-09-09
**Status:** Approved
**Platform:** Railway

## 1. Purpose

A bot that automatically enters NFT raffles on [Alphabot](https://www.alphabot.app) on behalf of
its owner, using Alphabot's official public API. It reacts in real time to raffles becoming
active, decides whether the owner can plausibly satisfy the raffle's requirements, submits the
entry, and reports the outcome to a Discord channel.

The owner has an active Alphabot **premium** subscription, which the API requires.

### Goals

- Enter eligible raffles within seconds of them becoming active.
- Only enter raffles whose requirements the owner can plausibly meet — in particular, raffles
  gated on Discord servers the owner has actually joined.
- Never exceed Alphabot's rate limits.
- Never enter the same raffle twice.
- Report every action to the owner's Discord channel.

### Non-goals

- Solving CAPTCHAs, or automating anything Alphabot deliberately gates behind a human check.
- Automating any account other than the owner's own.
- Reading Discord data through a user token / self-bot. That violates Discord's Terms of Service
  and risks permanent account termination. Discord data is read only through OAuth2, with the
  owner's explicit consent.
- Buying, minting, or transacting on-chain. The bot only registers raffle entries.

## 2. External constraints

Derived from the official OpenAPI document at
`https://api.alphabot.app/api/v1/alphabot-openapi-v1.json`.

| Item | Value |
|---|---|
| Base URL | `https://api.alphabot.app/v1/` |
| Auth | `Authorization: Bearer <ALPHABOT_API_KEY>` |
| `GET /raffles` | **30 requests / hour** |
| `GET /raffles/{slug}` | **30 requests / hour** (shares the same budget) |
| `POST /register` | 100 requests / minute |
| Webhook delivery | Alphabot POSTs to a URL configured in the owner's profile |
| Webhook auth | `body.hash` equals hex `HMAC_SHA256(API_KEY, event + "\n" + timestamp)` |
| Webhook contract | Must answer `200`. `webhook:test` must return `200` or Alphabot refuses to save the URL |

### The finding that shapes the architecture

The `raffle:active` webhook payload carries a **`RaffleWithRequirements`** object — the raffle
fields *plus* the full requirement set, including:

```text
discordServerRoles: [{ id, label, inviteLink, exclude, roles: [{ roleId, name, val, stacking }] }]
twitterFollows, twitterRetweet, requiredEth, requiredTokens,
connectCaptcha, connectPassword, requirePremium, excludePreviousWinners, ...
```

Over the polling API the same data costs a `GET /raffles/{slug}?requirements=true` call, drawn
from a budget of 30 per hour. The list endpoint only exposes `reqString` (which requirement
*types* exist) and `discordUrl` (the project's Discord, not necessarily the *required* server).

Therefore: **webhooks are the primary path, polling is the safety net.** The webhook path gets
precise Discord guild matching for free. The polling path has to buy it one request at a time,
which is affordable only within a strict budget — see the resolution rules in section 5.

## 3. Architecture

```text
Alphabot --raffle:active--> POST /alphabot --> verify HMAC --> 200 (immediately)
                                                   |
                                                   v
                                    entry queue (serial, 700ms gap, in-flight dedupe)
                                                   |
                           +-----------------------+
                           v                       v
                       filter.ts            POST /register --> store.ts --> Discord notify
                           ^
             guild whitelist (Discord OAuth2, refreshed every 6h)

poller (every 10 min) --> GET /raffles?status=active&filter=unregistered
                            +-> GET /raffles/{slug}?requirements=true (budgeted) --> entry queue
Alphabot --raffle:won--> POST /alphabot --> Discord notify
```

Two independent producers (webhook, poller) feed one consumer (the entry queue). The queue owns
all dedupe and pacing, so neither producer needs to know about the other.

### Rate-limit safety

All `GET` traffic passes through a token bucket capped at **28 requests per rolling hour** (limit
is 30; two held in reserve). The poller's default 10-minute interval spends 6/hour. A `429`
triggers exponential backoff honouring `Retry-After`. The bot cannot lock itself out of the API.

`POST /register` is paced at one every 700 ms — roughly 85/minute against a 100/minute limit.

## 4. Components

Each module has one job and a narrow interface, so it can be tested alone.

| Module | Responsibility |
|---|---|
| `src/config.ts` | Load `config.json` + env, validate with zod, expose a frozen typed config |
| `src/logger.ts` | Timestamped structured console output; redacts registered secrets |
| `src/api/client.ts` | fetch wrapper: bearer auth, JSON, retry with backoff, GET token bucket, 429 handling |
| `src/api/raffles.ts` | `listActiveRaffles()`, `getRaffleWithRequirements()`, `register()` |
| `src/api/types.ts` | Types transcribed from the OpenAPI schemas |
| `src/webhook/verify.ts` | `verifyHash(body, apiKey)` using `crypto.timingSafeEqual` |
| `src/webhook/server.ts` | `node:http` server and routing |
| `src/webhook/handlers.ts` | Map an event name to an action; unknown events acknowledged and ignored |
| `src/core/filter.ts` | **Pure.** `evaluate(raffle, ctx)` returns eligible or a skip reason |
| `src/core/store.ts` | Durable record of attempted slugs and their retry eligibility; atomic write to `DATA_DIR/entered.json` |
| `src/core/entry-queue.ts` | Serial queue, in-flight dedupe, pacing, skip-reason de-duplication, orchestrates filter to register to store to notify |
| `src/core/poller.ts` | Interval catch-up scan; budgeted requirement resolution and its cache; feeds the queue |
| `src/discord/oauth.ts` | Authorize URL, code exchange, token refresh |
| `src/discord/guilds.ts` | Paginated `/users/@me/guilds` fetch, cache, guild-id set |
| `src/discord/routes.ts` | `GET /discord/connect`, `GET /discord/callback` |
| `src/notify/discord.ts` | Discord webhook embeds for entered / skipped / failed / won / fatal |
| `src/index.ts` | Bootstrap and graceful shutdown |

### HTTP routes

| Route | Purpose |
|---|---|
| `POST /alphabot` | Alphabot webhook receiver |
| `GET /health` | Railway health check; uptime, queue depth, attempted vs entered counts, guild-list age, remaining GET budget |
| `GET /discord/connect` | Redirect to Discord OAuth2 authorize |
| `GET /discord/callback` | Exchange code, persist tokens, fetch guild list |

## 5. Eligibility rules (`filter.ts`)

Evaluated in order; the first match wins and yields a machine-readable reason.

1. `status !== 'active'` -> skip (`not_active`)
2. `endDate` already past -> skip (`ended`)
3. slug already in store -> skip (`already_entered`)
4. `connectCaptcha` and `entry.skipCaptcha` -> skip (`captcha_required`). Default is `false`:
   the API's `validation` object has no captcha field, so whether `POST /register` enforces the
   requirement at all is unknown, and the bot lets Alphabot answer rather than guessing. Nothing
   here reads or solves a CAPTCHA.
5. `connectPassword` and no password configured -> skip (`password_required`)
6. `requiredTokens` non-empty and `entry.skipTokenGated` -> skip (`token_gated`)
7. `requiredEth > 0` and `entry.skipTokenGated` -> skip (`eth_balance_required`)
8. `reqString` contains `n` (NFT holding) and `entry.skipNftHolding` -> skip (`nft_holding_required`)
9. `discordServerRoles` non-empty and `discord.requireGuildWhitelist`: the entries with
   `exclude !== true` are matched against the known guild set. `discord.guildMatchMode` decides
   how strictly: `any` (default) needs at least one match, `all` needs every one. Otherwise ->
   skip (`discord_guild_not_joined`), carrying a `detail` naming the missing servers.

   Alphabot lists gating servers and bonus-entry servers in the same array — the `val` and
   `stacking` fields on `roles` are entry multipliers — with no flag distinguishing them.
   Requiring all of them was the original guess and it rejected every raffle in production
   despite 63 joined servers, so `any` is the default. `all` remains available for an owner who
   wants the stricter reading.
10. `allowedBlockchains` non-empty and `blockchain` not in it -> skip (`blockchain_excluded`)
11. `excludeKeywords` matches `name` (case-insensitive) -> skip (`keyword_excluded`)
12. `winnerCount < minWinnerCount` -> skip (`too_few_winners`)
13. otherwise -> **eligible**

Twitter follow / like / retweet requirements are deliberately *not* filtered on: entering is
cheap, and Alphabot's own `validation` object reports authoritatively whether they were met.

The known guild set is the union of the OAuth2-derived guild list and any ids in
`discord.guildIds` / `DISCORD_GUILD_IDS`. When OAuth2 has never been connected and no manual ids
are set, `requireGuildWhitelist` degrades to "skip every Discord-gated raffle", and the bot warns
once at startup so the degradation is never silent.

Raffles arriving from the poller carry only `RaffleForList` — no `discordServerRoles`. The filter
alone would skip them with `discord_requirements_unknown`, which would leave the entire backlog of
already-active Discord-gated raffles permanently unreachable.

The poller therefore resolves them before submitting: for each listed raffle whose `reqString`
contains `d` or `r`, it fetches `GET /raffles/{slug}?requirements=true` and submits the enriched
object, which then takes the normal `discordServerRoles` branch of rule 9.

Three guards keep this inside the 30/hour budget:

- `poll.maxResolvesPerCycle` (default 10) caps the work per cycle.
- Resolution stops while `client.budgetRemaining` is at or below a reserve of 4, so the next
  cycle's list call always fits.
- Each slug is resolved at most once per process, and never if it is already in the store. A slug
  whose resolution failed for an ordinary reason is also marked done, so one broken raffle cannot
  burn the budget every cycle. A slug denied by the budget is *not* marked, so it is retried.

Because the list is sorted `ending` ascending, the most urgent raffles are resolved first. The
token bucket remains the hard backstop: if it refuses, the raffle is submitted unresolved and the
filter skips it, to be retried on a later cycle.

Resolved requirements are cached in memory and re-submitted on later cycles, so a raffle is
fetched once and then keeps its enriched form. The cache is pruned to whatever is still active at
the end of each scan. Both the cache and the attempted set are memory-only; a restart re-resolves,
which is bounded by the same guards — accepted rather than adding another persisted state file.

### Re-evaluation

The entry queue's dedupe set guards against processing one slug twice *concurrently*, and nothing
more. Protection against entering a raffle twice comes from the store, which is durable and
authoritative.

This matters because a verdict is only as good as the information available when it was made. A
raffle judged before OAuth2 filled the guild whitelist, or before the poller resolved its
requirements, must be reconsidered once that information arrives — without a restart. Since the
poller re-submits every active raffle each cycle, dropping the slug from the in-flight set after
processing is all that is needed.

The cost is that a permanently ineligible raffle is re-judged every cycle. That is a pure function
call with no API traffic, so the only real cost would be repeated log lines; the queue therefore
remembers each slug's last skip reason and reports only a verdict that actually changed.

## 6. Configuration

`config.json` holds behaviour, environment holds secrets. Env wins on conflict, so values can be
changed on Railway without a redeploy.

```jsonc
{
  "poll":  { "enabled": true, "intervalSeconds": 600, "pageSize": 50 },
  "entry": {
    "delayMs": 700,
    "dryRun": false,
    "skipCaptcha": true,
    "skipNftHolding": true,
    "skipTokenGated": true,
    "allowedBlockchains": [],
    "excludeKeywords": [],
    "minWinnerCount": 0
  },
  "discord": { "requireGuildWhitelist": true, "guildIds": [], "refreshHours": 6 },
  "submission": { "mintAddress": null, "discordId": null, "twitterId": null, "telegramId": null }
}
```

Any `submission` field left `null` is omitted from `POST /register`, which makes Alphabot fall
back to the owner's profile defaults — the desired behaviour in almost every case.

| Env var | Required | Purpose |
|---|---|---|
| `ALPHABOT_API_KEY` | yes | API auth **and** webhook HMAC secret |
| `PORT` | injected by Railway | HTTP listen port |
| `PUBLIC_BASE_URL` | for OAuth | e.g. `https://app.up.railway.app`, used to build the redirect URI |
| `DATA_DIR` | no (default `./data`) | Volume mount path |
| `DISCORD_CLIENT_ID` | for OAuth | Discord application id |
| `DISCORD_CLIENT_SECRET` | for OAuth | Discord application secret |
| `DISCORD_NOTIFY_WEBHOOK_URL` | no | Channel webhook for notifications |
| `DISCORD_GUILD_IDS` | no | Comma-separated manual guild ids, merged with OAuth results |
| `RAFFLE_PASSWORD` | no | Answer for password-gated raffles |

## 7. Error handling

| Situation | Behaviour |
|---|---|
| `401` from Alphabot | Fatal for API work. Log clearly (key invalid or subscription lapsed), notify Discord, stop the poller. The webhook server keeps running so the configured URL stays valid. |
| `429` | Back off exponentially, honour `Retry-After`, retry up to 5 times |
| `400` on register | Alphabot declined the entry, so nothing was registered. Record it with a `retryAfter` of `entry.retryHours`, log it, continue. Not posted to Discord — rejections are expected and would flood the channel. |
| Validation `success: false` | Same treatment as a `400`: recorded, retryable, logged only. |
| Network / 5xx | Retry 3 times with exponential backoff and jitter. If it still fails the outcome is **unknown**, so the record is permanent — retrying could double-enter. Posted to Discord, because this is not something the owner could have predicted. |
| Invalid webhook hash | Respond `200` (never leak validity), log the source address, drop the event |
| Malformed webhook body | Respond `200`, log, drop |
| Store write failure | Log and continue in memory; a lost record costs at most a redundant re-entry |
| Win webhook never delivered | `WinAnnouncer.reconcile()` asks `GET /raffles?filter=winners` at startup and every `poll.reconcileWinsHours`, and announces any win the bot entered but never announced. Wins on raffles the bot did not enter are seeded as already announced. |
| Discord notify failure | Retried: a `429` waits exactly as long as Discord asks, a `5xx` or network error backs off. Posts to one channel are queued in order and paced under the 30-per-minute channel ceiling. Entering never waits on any of it, and a shutdown flushes the queue. Only a non-`429` `4xx` is dropped, because Discord will never accept that payload. |
| Win alert undeliverable | The win stays recorded; only `announced` is left unset, so it sits in `pendingWins()` and `WinAnnouncer` retries it every poll cycle. Nothing depends on Alphabot redelivering, and a redelivery colliding with an attempt in flight is safely ignored. Records written before `announced` existed count as announced, so old wins are never replayed. |

Alphabot requires a `200` for essentially everything, so the server answers `200` first and does
all real work afterwards, off the request path.

## 8. Security

- Secrets come from the environment only, never from `config.json`, and are never logged. The
  logger redacts any registered secret value found in a log line.
- `.env` and `data/` are git-ignored.
- Webhook verification uses `crypto.timingSafeEqual` on equal-length buffers.
- The OAuth callback validates a signed `state` parameter to prevent CSRF, and
  `/discord/connect` is only useful to whoever can complete Discord's own login.
- Discord tokens are stored in the volume, never printed, and only ever sent to `discord.com`.
- The bot writes nothing on-chain and holds no private keys.

## 9. Testing

`vitest`, target at least 80% coverage, unit-first, `fetch` always mocked — no test touches the
network.

| Target | Cases |
|---|---|
| `filter.ts` | Every rule above, the `exclude: true` guild case, the empty-whitelist degradation, and the poller `reqString` fallback |
| `verify.ts` | Valid hash, wrong hash, wrong length, missing fields, wrong key |
| `client.ts` | Retry on 5xx, backoff on 429 with `Retry-After`, token bucket refusing the 29th GET in an hour |
| `store.ts` | Round-trip, atomic write, corrupted-file recovery |
| `entry-queue.ts` | Dedupe across producers, pacing, dry-run suppresses the POST |
| `guilds.ts` | Pagination past 200 guilds, cache expiry, merge with manual ids |
| `config.ts` | Missing required env, invalid values, env overriding file |

`--dry-run` provides an end-to-end rehearsal against the live API without registering anything.

## 10. Deployment (Railway)

1. Push the repo; create a Railway service from it. The build uses the committed `Dockerfile`.
2. Attach a **Volume** mounted at `/data` and set `DATA_DIR=/data`.
3. Settings, Networking, **Generate Domain**.
4. Set the variables from the table in section 6.
5. Discord Developer Portal, new application, copy Client ID and Secret, add redirect URI
   `https://<domain>/discord/callback`.
6. Visit `https://<domain>/discord/connect` once and authorize.
7. Alphabot profile, developer section: set the webhook URL to `https://<domain>/alphabot`.
   Alphabot sends `webhook:test`; a `200` confirms and saves it.
8. Create a Discord channel webhook and set `DISCORD_NOTIFY_WEBHOOK_URL`.

Railway has no permanent free tier; the service must stay awake for webhooks to arrive. While the
container is asleep or redeploying, `raffle:active` events are lost and only the poller's
catch-up scan will find those raffles.
