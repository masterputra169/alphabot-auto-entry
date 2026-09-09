# Alphabot Auto Entry

Automatically enters Alphabot NFT raffles for **your own account** using Alphabot's official
public API. Alphabot pushes `raffle:active` webhooks; the bot decides whether you qualify and
registers the entry within seconds.

Requires an active Alphabot subscription — the API is subscription-gated.

## How it works

- **Webhooks are the primary trigger.** The `raffle:active` payload carries the full requirement
  set, including `discordServerRoles` — the exact Discord servers a raffle is gated on. That data
  costs nothing to receive.
- **Polling is only a safety net.** `GET /raffles` is limited to 30 requests per hour, so the
  client caps usable GETs at 28 per rolling hour and the poller runs every 10 minutes to cover
  the window where the bot was down.
- **Discord matching is real.** Raffles are checked against the servers you have actually joined,
  read through OAuth2 with the `identify guilds` scope. No user token, no self-bot — that would
  violate Discord's Terms of Service.
- **Nothing is entered twice.** Every attempt is recorded, and the record survives redeploys when
  a volume is mounted.

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
   | `DISCORD_GUILD_IDS` | optional, comma separated, merged with the OAuth list |
   | `RAFFLE_PASSWORD` | optional, answer for password-gated raffles |

5. **Discord app:** create one at <https://discord.com/developers/applications>, then add the
   redirect URI `https://<your-domain>/discord/callback`.
6. Open `https://<your-domain>/discord/connect` once and authorize.
7. **Alphabot webhook:** in your Alphabot profile developer section, set the webhook URL to
   `https://<your-domain>/alphabot`. Alphabot sends `webhook:test`; a 200 saves it.

`https://<your-domain>/health` reports uptime, queue depth, remaining GET budget, how many
raffles have been attempted, and whether Discord is connected.

## Tuning

Edit `config.json` and redeploy. The defaults skip raffles needing a CAPTCHA, an NFT holding, a
token or ETH balance, or a Discord server you have not joined.

| Setting | Effect |
|---|---|
| `entry.dryRun` | Log decisions without registering |
| `entry.allowedBlockchains` | e.g. `["ethereum", "solana"]`; empty means all |
| `entry.excludeKeywords` | Case-insensitive substrings matched against the raffle name |
| `entry.minWinnerCount` | Ignore raffles with very few winners |
| `entry.skipNftHolding` | Set `false` to attempt raffles requiring an NFT you may hold |
| `discord.requireGuildWhitelist` | Set `false` to attempt Discord-gated raffles regardless |
| `poll.intervalSeconds` | Minimum 120; the default 600 spends 6 of the 30 hourly GETs |

Any `submission` field left `null` is omitted from the request, so Alphabot uses your profile
defaults — which is what you want in almost every case.

## Limitations

- CAPTCHA-gated raffles are never entered. That gate exists to require a human.
- While the container is asleep or redeploying, `raffle:active` events are lost. The poller
  catches most of them afterwards, except Discord-gated ones: the list endpoint does not say
  which server a raffle requires, and resolving it would spend the scarce GET budget.
- Railway has no permanent free tier. The service must stay awake for webhooks to arrive.

## Development

```bash
npm test           # unit tests
npm run test:cov   # with coverage thresholds
npm run typecheck  # tsc --noEmit
```

Every module is unit-tested with `fetch` mocked; no test touches the network.
