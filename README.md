# Gamelist Discord Widget Worker

Cloudflare Worker that rebuilds the Discord widget JSON from the public Gamelist API, updates Discord on an hourly cron, and exposes a private manual refresh endpoint.

## Setup

Install dependencies:

```sh
npm install
```

Set Discord secrets:

```sh
wrangler secret put DISCORD_BOT_TOKEN
wrangler secret put DISCORD_USER_ID
wrangler secret put DISCORD_APP_ID
wrangler secret put DISCORD_ACCESS_TOKEN
wrangler secret put REFRESH_SECRET
```

`DISCORD_ACCESS_TOKEN` is optional, but useful as a fallback if Discord rejects the bot-token identity update with OAuth error `50025`.

Public config lives in `wrangler.toml`:

```toml
GAMELIST_BASE_URL = "https://gamelist.shabiimitjans.workers.dev"
TOTAL_COMPLETED_COUNT = "41"
TOTAL_COMPLETED_THIS_YEAR = "1"
```

## Local Dev

For local testing, create `.dev.vars`:

```ini
DISCORD_BOT_TOKEN="..."
DISCORD_USER_ID="..."
DISCORD_APP_ID="..."
DISCORD_ACCESS_TOKEN="..."
REFRESH_SECRET="choose-a-long-random-value"
```

Run:

```sh
npm run dev
```

Manual refresh:

```sh
curl "http://localhost:8787/refresh?secret=choose-a-long-random-value"
```

You can also pass the secret as a bearer token:

```sh
curl -H "Authorization: Bearer choose-a-long-random-value" "http://localhost:8787/refresh"
```

## Deploy

```sh
npm run deploy
```
