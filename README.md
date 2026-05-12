# casinoGames

New standalone project for casino game aggregation.

## What is included

- Core engine with source/service plugin pipeline
- HTTP API for external apps
- CLI for local usage
- Output format selection: json, csv, table

## Quick start

1. Install dependencies:

   npm install

2. Run API:

   npm run start:api

3. Run CLI:

   npm run start:cli -- --ids 1001,1002 --format table

## Source selection

Sources are selected with `CASINO_SOURCES` env var.

- Default: `slotcatalog,slotstemple,livebet`
- Mock mode: `CASINO_SOURCES=mock`
- SlotsTemple mode: `CASINO_SOURCES=slotstemple`
- Livebet mode: `CASINO_SOURCES=livebet`
- Multiple sources: `CASINO_SOURCES=slotcatalog,mock`

PowerShell examples:

```powershell
$env:CASINO_SOURCES='mock'; npm run start:cli -- --ids 1001,1002 --format json
$env:CASINO_SOURCES='slotcatalog'; npm run start:cli -- --ids "book of dead" --format table
$env:CASINO_SOURCES='slotstemple'; npm run start:cli -- --ids "book of dead" --format json
$env:CASINO_SOURCES='livebet'; npm run start:cli -- --ids "book of dead" --format json
```

## Long request handling

For slow scraping requests, use async mode via API.

1. Submit job:

```http
POST /v1/search
Content-Type: application/json

{
   "ids": ["book of dead"],
   "format": "json",
   "async": true
}
```

2. Poll status:

```http
GET /v1/jobs/{jobId}
```

## Retry and timeout tuning

- `CASINO_SOURCE_TIMEOUT_MS` (default: `90000`)
- `CASINO_SOURCE_RETRIES` (default: `1` retry)
- `API_RATE_LIMIT_WINDOW_MS` (default: `60000`)
- `API_RATE_LIMIT_MAX` (default: `60`)

## API example

POST /v1/search

```json
{
  "ids": ["1001", "1002"],
  "format": "json"
}
```

Supported format values: `json`, `csv`, `table`.

Health and readiness endpoints:

- `GET /health` -> process is running
- `GET /ready` -> app is ready to serve requests (sources resolved)

Production middleware included:

- `helmet` for common security headers
- request id on every response via `x-request-id`
- basic access logging
- rate limit on `/v1/*`

## Deploy (free start)

Recommended first production setup: Render free web service with auto-deploy from GitHub.

1. Push project to GitHub.
2. In Render, create new service from repo.
3. Render auto-detects `render.yaml` and provisions service.
4. Keep `plan: free` and deploy.

Included files:

- `Dockerfile` for production runtime
- `render.yaml` for one-click Render provisioning
- `.dockerignore` for faster builds

Important note for free tier:

- Free instances can sleep and cold-start.
- Current async jobs are in-memory and are lost on restart/sleep.
- Next upgrade step is persistent job store (Redis/Postgres).

## Update flow (after first deploy)

1. Create feature branch, implement change, open PR.
2. GitHub Actions runs `.github/workflows/ci.yml`.
3. Merge PR to `main`.
4. Render auto-deploys latest `main` commit.

Minimal local check before push:

```powershell
npm run check:syntax
```

Local production smoke check:

```powershell
npm run smoke:local
```

## Branch protection and releases

Recommended GitHub settings for production safety:

1. Protect `main` branch.
2. Require pull request before merge.
3. Require status checks to pass (`CI / verify`).
4. Disable force-push to `main`.

Release tagging flow (for rollback-friendly updates):

1. Merge to `main`.
2. Create annotated tag (example: `v0.1.0`).
3. Push tag to GitHub.

PowerShell example:

```powershell
git tag -a v0.1.0 -m "Release v0.1.0"
git push origin v0.1.0
```

Automated release behavior:

- Push tag `v*` triggers `.github/workflows/release.yml`
- Workflow runs `npm ci` + `npm run check:syntax`
- On success, GitHub Release is created with auto-generated notes

## Post-deploy smoke check

For quick production verification after deploy:

1. Open GitHub Actions.
2. Run `Smoke Check` workflow.
3. Pass deployed base URL or set repository variable `SMOKE_BASE_URL`.

Workflow verifies:

- `GET /health`
- `GET /ready`

## Plugin model

- Source plugins fetch data by IDs.
- Service plugins enrich or transform unified records.

Add new source plugins in `src/plugins/sources` and register them in `src/plugins/registry.js`.
