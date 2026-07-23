# Gamelist Discord Widget Worker

Cloudflare Worker that rebuilds the Discord widget JSON from the public Gamelist API, updates Discord every 30 minutes, and exposes a private manual refresh endpoint.

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

## First Discord Authorization

Create a local `.env` file for the one-off Node updater:

```ini
DISCORD_BOT_TOKEN="..."
DISCORD_USER_ID="..."
DISCORD_APP_ID="..."
DISCORD_ACCESS_TOKEN=""
GAMELIST_BASE_URL="https://gamelist.shabiimitjans.workers.dev"
TOTAL_COMPLETED_COUNT="41"
TOTAL_COMPLETED_THIS_YEAR="1"
```

Load it in PowerShell:

```powershell
Get-Content .env | ForEach-Object {
  if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
    [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim().Trim('"'), 'Process')
  }
}
```

Print the Discord authorization URLs:

```sh
npm run discord:auth
```

Or open the deployed Worker auth page:

```text
https://your-worker-url/auth
```

The Discord widget setup guide is available from the deployed Worker too:

```text
https://your-worker-url/guide
```

Open the URLs while logged into the Discord account from `DISCORD_USER_ID`. If Discord redirects with an `access_token` in the URL, add it to `.env` as `DISCORD_ACCESS_TOKEN`, reload `.env`, then run:

```sh
npm run discord:update
```

You can preview the generated payload without updating Discord:

```sh
npm run discord:dry-run
```

Public config lives in `wrangler.toml`:

```toml
GAMELIST_BASE_URL = "https://gamelist.shabiimitjans.workers.dev"
TOTAL_COMPLETED_COUNT = "41"
TOTAL_COMPLETED_THIS_YEAR = "1"
```

The Worker calls the Gamelist Worker through a Cloudflare Service Binding:

```toml
[[services]]
binding = "GAMELIST"
service = "gamelist"
```

If your main Gamelist Worker has a different Cloudflare service name, update `service = "gamelist"` before deploying.

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
