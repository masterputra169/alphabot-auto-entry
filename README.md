# Alphabot Auto Entry

Automatically enters Alphabot NFT raffles for **your own account** using Alphabot's official
public API. Alphabot pushes `raffle:active` webhooks; the bot decides whether you qualify and
registers the entry within seconds.

Requires an active Alphabot subscription — the API is subscription-gated.

## How it works

- **Webhooks are the primary trigger.** The `raffle:active` payload carries the full requirement
  set, including `discordServerRoles` — the exact Discord servers a raffle is gated on. That data
  costs nothing to receive.
- **Polling is the safety net.** `GET /raffles` is limited to 30 requests per hour, so the client
  caps usable GETs at 28 per rolling hour and the poller runs every 10 minutes to cover the window
  where the bot was down. It also resolves Discord-gated raffles the list endpoint cannot describe,
  by fetching their requirements individually within the leftover budget.
- **Discord matching is real.** Raffles are checked against the servers you have actually joined,
  read through OAuth2 with the `identify guilds` scope. No user token, no self-bot — that would
  violate Discord's Terms of Service.
- **Nothing is entered twice.** Every attempt is recorded, and the record survives redeploys when
  a volume is mounted. A successful entry is never repeated. An entry Alphabot *declined* is
  retried after `entry.retryHours`, because "one or more tasks incomplete" is something you can
  go and fix. A failure whose outcome is unknown stays permanent.
- **Wins get their own channel.** Alphabot's `raffle:won` webhook is the trigger. Set
  `DISCORD_WIN_WEBHOOK_URL` to a webhook for a channel of its own and only wins land there;
  leave it empty and wins keep going to the main channel. Alphabot redelivers webhooks, so a win
  is recorded the moment it is known and that record outlives both a later entry attempt and a
  redeploy. Winning and announcing are tracked separately: a win whose alert never reached
  Discord stays on a backlog that the bot retries itself every poll cycle, so nothing depends on
  Alphabot choosing to redeliver, and `won` in `/health` always reflects what you actually won.
  The same raffle is never announced twice. A won raffle also drops out of `blockedBy` and
  `blockedByTask`, since there is nothing left to fix.
- **An alert is not lost because Discord was busy.** Posts to one channel are queued, kept in
  order and spaced to stay under Discord's 30-messages-a-minute ceiling, so a burst of entries
  cannot outrun it. A rate limit is waited out for exactly as long as Discord asks; a `5xx` or a
  network failure is retried with backoff. Entering a raffle never waits on any of this — a
  first-come raffle is not going to wait for a chat message — and a shutdown flushes whatever
  is still queued.
- **A missed win is still found.** Webhooks are the fast path, but a `raffle:won` delivered while
  the container is restarting is simply gone, and a win nobody was ever told about looks exactly
  like a win whose alert failed. So the bot also asks Alphabot outright which raffles it has won,
  at startup and every few hours, and announces anything the webhooks never delivered. Wins on
  raffles this bot did not enter are recorded but not announced - they are the owner's own, and a
  first run could turn up years of them.
- **The record stays small.** Every attempt rewrites `entered.json` whole, so a raffle whose
  retry time has passed is forgotten — it was already eligible again, and keeping it changed no
  decision. Compaction runs on startup and once a poll cycle. `attempted` in `/health` therefore
  counts what is still remembered, not everything ever tried.
- **Verdicts are revisited, not frozen.** A raffle skipped because Discord was not yet connected,
  or because its requirements had not been fetched, is judged again on the next poll cycle. No
  restart needed.

```
Alphabot --raffle:active--> POST /alphabot --> verify HMAC --> 200 immediately
                                                   |
                                    entry queue (serial, dedupe, 700ms pacing)
                                                   |
                                 filter --> POST /register --> store --> Discord embed
                                    ^
                      your guild list (OAuth2, refreshed every 6h)
```

## Local setup

```bash
npm install
cp .env.example .env      # fill in ALPHABOT_API_KEY
npm test
npm run build
node dist/index.js --dry-run   # rehearse without registering anything
```

`node dist/index.js --once` runs a single poll cycle and exits.

## Deploy to Railway

1. Push this repo to GitHub and create a Railway service from it. The build uses `Dockerfile`.
2. **Volume:** add one mounted at `/data`, then set `DATA_DIR=/data`. Without it, the entry
   history and Discord tokens are lost on every redeploy.
3. **Domain:** Settings → Networking → **Generate Domain**.
4. **Variables:**

   | Variable | Value |
   |---|---|
   | `ALPHABOT_API_KEY` | from your Alphabot profile |
   | `PUBLIC_BASE_URL` | `https://<your-domain>` |
   | `DATA_DIR` | `/data` |
   | `DISCORD_CLIENT_ID` | Discord application id |
   | `DISCORD_CLIENT_SECRET` | Discord application secret |
   | `DISCORD_NOTIFY_WEBHOOK_URL` | a channel webhook in your own server |
   | `DISCORD_WIN_WEBHOOK_URL` | optional, webhook of a separate channel that receives win alerts only |
   | `DISCORD_WIN_MENTION` | optional, posted beside a win embed so it pings, e.g. `@everyone` |
   | `DISCORD_GUILD_IDS` | optional, comma separated, merged with the OAuth list |
   | `MINT_ADDRESS` | optional, wallet submitted with each entry; overrides `submission.mintAddress` |
   | `RAFFLE_PASSWORD` | optional, answer for password-gated raffles |

5. **Discord app:** create one at <https://discord.com/developers/applications>, then add the
   redirect URI `https://<your-domain>/discord/callback`.
6. Open `https://<your-domain>/discord/connect` once and authorize.
7. **Alphabot webhook:** in your Alphabot profile developer section, set the webhook URL to
   `https://<your-domain>/alphabot`. Alphabot sends `webhook:test`; a 200 saves it.

`https://<your-domain>/health` reports uptime, queue depth, remaining GET budget, `attempted`
(every raffle tried) versus `entered` (the ones Alphabot accepted) versus `won`, `blockedBy` (a
count of the raffles currently held back, grouped by Alphabot's own rejection reason),
`blockedByTask`, and whether Discord is connected.

`blockedByTask` counts how many raffles each outstanding task is holding up, so
`{"discord": 47, "twitter": 12}` means Discord requirements are the biggest thing standing in the
way. Alphabot reports these per category, and only a category it explicitly marks failed counts.

`blockingServers` goes one step further and names them, ranked by how much each one unlocks:

```json
[{ "label": "Surge Alpha", "raffles": 5, "roles": ["Verified"],
   "invite": "https://discord.gg/..." },
 { "label": "Lumex", "raffles": 1, "roles": [], "invite": null }]
```

`roles` tells you how much work each one is, cheapest first. An empty list means plain membership
is enough. Otherwise the roles are **alternatives, not a checklist** - each carries an entry
multiplier, so the lowest `val` is normally the basic role a server grants on verification and the
higher ones are tiers that just award more entries:

```json
"roles": [{ "name": "Waiting Room", "val": 1 },
          { "name": "VIP Surge",    "val": 5 },
          { "name": "Surge Gods",   "val": 10 }]
```

Alphabot checks the role, not the join, so a server can be public and still block you until you
pick up its basic role.

Deal with the server at the top and the bot enters those raffles by itself on the next retry
pass - no restart, nothing to click. `blockingServersPending` says how many blocked raffles have not
been looked up yet; they are worked through within the hourly GET budget.

You do not have to go looking for this: the same list is posted to the notify channel once a day,
and once at startup. Alphabot also runs whole families of raffles off one project, and those share
a Discord requirement, so one lookup answers for the whole family instead of one GET each - which
is the difference between the report keeping up and staying hundreds of raffles behind.

## Tuning

Edit `config.json` and redeploy. The defaults skip raffles needing an NFT holding, a token or ETH
balance, or a Discord server you have not joined.

| Setting | Effect |
|---|---|
| `entry.dryRun` | Log decisions without registering |
| `entry.allowedBlockchains` | e.g. `["ethereum", "solana"]`; empty means all |
| `entry.excludeKeywords` | Case-insensitive substrings matched against the raffle name |
| `entry.minWinnerCount` | Ignore raffles with very few winners |
| `entry.retryHours` | How long before a declined entry is attempted again (default 6). A raffle Alphabot reports as ended, or as already won, is never rescheduled. |
| `entry.maxRetryHours` | Ceiling on that wait (default 24). Each further decline for the same reason doubles it, so a raffle nobody is going to unblock stops costing an attempt every few hours. A different reason starts the count over. |
| `poll.reconcileWinsHours` | How often to ask Alphabot which raffles were won (default 6, `0` disables). Costs one GET. |
| `notify.blockerDigestHours` | How often to post the "servers worth joining" digest (default 24, `0` disables). Also sent once at startup, since a timer on a service that redeploys would otherwise rarely fire. |
| `notify.blockerDigestSize` | How many servers that digest names (default 5). |
| `entry.skipNftHolding` | Set `false` to attempt raffles requiring an NFT you may hold |
| `entry.skipCaptcha` | Default `false`: attempt CAPTCHA-flagged raffles and let Alphabot decide |
| `discord.requireGuildWhitelist` | Set `false` to attempt Discord-gated raffles regardless |
| `discord.guildMatchMode` | `any` (default) enters if you are in at least one listed server; `all` demands every one |
| `poll.intervalSeconds` | Minimum 120; the default 600 spends 6 of the 30 hourly GETs |
| `poll.resolveDiscordRequirements` | Set `false` to stop the poller fetching requirements for Discord-gated raffles |
| `poll.maxResolvesPerCycle` | How many of those fetches one cycle may make (default 10) |

Any `submission` field left `null` is omitted from the request, so Alphabot uses your profile
defaults — which is what you want in almost every case.

## Limitations

- CAPTCHA-flagged raffles are attempted, not solved. The API's `validation` object has no captcha
  field, so it is unclear whether `POST /register` checks that requirement at all; the bot lets
  Alphabot answer and reports whatever comes back. Set `entry.skipCaptcha: true` to filter them out
  again. Nothing here reads or solves a CAPTCHA image.
- While the container is asleep or redeploying, `raffle:active` events are lost. The poller
  recovers them afterwards, including Discord-gated ones, but resolution is rate-limited to
  roughly 22 raffles per hour by the 30 GET/hour API budget. A large backlog is worked through
  soonest-ending first, so the most urgent raffles are handled first.
- Railway has no permanent free tier. The service must stay awake for webhooks to arrive.

## Development

```bash
npm test           # unit tests
npm run test:cov   # with coverage thresholds
npm run typecheck  # tsc --noEmit
```

Every module is unit-tested with `fetch` mocked; no test touches the network.
