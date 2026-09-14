# Task Desk

A calm, read-only lens over Linear and Outlook that answers two questions the moment it opens:
what today is, and what the week expects of you.

Runs locally on one Mac, reached from phone and wall monitor over Tailscale.
Full specification in [PRD.md](./PRD.md).

---

## Quick start

```bash
npm install
npm run dev          # http://127.0.0.1:41733
```

| Script | What it does |
|---|---|
| `npm run dev` | Dev server, bound to loopback only, on port **41733** |
| `npm run build` / `npm start` | Production build and serve |
| `npm run test` | Unit tests (vitest) |
| `npm run test:e2e` | Browser tests (Playwright) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run verify` | typecheck + lint + unit tests |

### The port

**41733, not 3000.** Port 3000 collects orphans — any other Node project on this machine claims
it first, `next dev` then exits with `EADDRINUSE`, and you spend an afternoon testing a server
that has been running since this morning. Playwright reads the same port, so the two cannot
drift.

Set `PORT` to override it in both places:

```bash
PORT=45000 npm run dev
```

If a start ever seems not to take effect, the server is almost certainly already running. Its
process is named `next-server`, not `next dev`, so `pkill -f "next dev"` will not find it —
kill it by port instead:

```bash
lsof -ti :41733 | xargs kill -9
```

## Environment

All secrets live in `.env`, which is git-ignored. The app validates them at boot and fails fast
naming any missing key.

| Variable | Required | Purpose |
|---|---|---|
| `LINEAR_API_KEY` | yes | Linear GraphQL. Team `RW` only. |
| `GRAPH_TENANT_ID` / `GRAPH_CLIENT_ID` / `GRAPH_SECRET` | yes | Outlook Calendar via Microsoft Graph |
| `AI_API_KEY` / `AI_API_URL` | yes | OpenAI-compatible gateway (URL already includes `/v1`) |
| `OMNI_API_KEY` | no | Omni search. **Not yet issued** — without it the enrichment blocks degrade gracefully. |
| `BRAIN_API_KEY` / `BRAIN_MCP_URL` | no | Brain CRM over MCP, for the Account status block |
| `SENTENCE_LOCALE` | no | `en` (default) or `nl` |

### A note on the Graph credential

The Entra app holds `Calendars.Read.All`, which is **tenant-wide**. The only thing restricting
Task Desk to one mailbox is the hard-coded `GRAPH_USER_PRINCIPAL_NAME` constant in
`lib/config.ts`. It must never become a parameter, an environment variable, or anything derived
from request input. `lib/graph/calendar.test.ts` asserts this. See PRD §17.8.

## Architecture

Three data paths, deliberately separate (PRD §15.1):

```
Linear   ──► GraphQL API, direct        issues, states, due dates
Calendar ──► Microsoft Graph, direct    events, attendees, end times
Omni     ──► /api/v1/search             mail, transcripts, files, Slack
Brain    ──► MCP over HTTP              CRM account status
```

Calendar does **not** go through Omni: Omni's connector drops event end times and locations into
free text, and the timeline needs them structured (PRD §15.5).

```
app/            routes; Server Components by default
components/     presentational, client only where interactive
lib/config.ts   env validation + the single-identity constant
lib/time.ts     everything date/time, fixed to Europe/Amsterdam
lib/cache.ts    in-process TTL cache — no database in v1
lib/linear/     lib/graph/  lib/omni/  lib/brain/  lib/ai/
lib/domain/     pure logic: states, ranking, timeline, week
```

State lives in an in-process cache. The app is a permanently-running local server, so a restart
simply re-warms it. Nothing is ever written to Omni's Postgres or the archive database.

## Display modes

| URL | For |
|---|---|
| `/` | Phone and desktop |
| `/?display=board` | The always-on 1600×600 wall monitor |

Board mode is an explicit flag, never inferred from viewport width — 1600×600 is
indistinguishable from an ordinary laptop window, so inferring it would flip a normal browser
into a truncated polling display on resize. See PRD §17.13.

## Serving over Tailscale

Tailnet `tail981ec3.ts.net`, node `ruuds-macbook-pro-2023`. **Hermes already owns `/`**
(proxying `127.0.0.1:27462`), so Task Desk publishes on its own HTTPS port:

```bash
npm run build && npm start                               # binds 127.0.0.1:41733
tailscale serve --bg --https=8443 http://127.0.0.1:41733
tailscale serve status                                  # confirm
```

Then:

- Phone / desktop — `https://ruuds-macbook-pro-2023.tail981ec3.ts.net:8443`
- Wall monitor — `https://ruuds-macbook-pro-2023.tail981ec3.ts.net:8443/?display=board`

To stop publishing: `tailscale serve --https=8443 off`.

> **Never enable Funnel.** The tailnet is the entire security boundary — there is no application
> login (PRD §12.1). `tailscale funnel status` must stay empty.

## Task tracking

This repo uses [beads](https://github.com/gastownhall/beads). `bd ready` shows available work,
`bd show <id>` the detail. Issues map to PRD sections.
