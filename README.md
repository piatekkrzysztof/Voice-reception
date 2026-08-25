# Voice Reception

An AI receptionist that answers the phone, checks the calendar and books the appointment —
and cannot double-book, because the booking is a database transaction rather than a
promise made in conversation.

![node](https://img.shields.io/badge/node-24-339933)
![tests](https://img.shields.io/badge/tests-15%20passing-brightgreen)
![deps](https://img.shields.io/badge/runtime%20deps-1-blue)
![status](https://img.shields.io/badge/status-pilot%20ready-yellow)
![licence](https://img.shields.io/badge/licence-source--available-lightgrey)

> **Language note.** This README is English; the console, code comments and the documents
> in `docs/` are Polish, because the product serves Polish service businesses.

---

## What it does

A service business — a clinic, a salon, a workshop — misses calls. Voice Reception picks
up, states plainly that it is an AI, offers to book, checks real availability, holds the
slot, confirms it, and hands the call to a human whenever the caller asks.

The hard part is not the conversation. It is that a voice agent will happily say "booked
for Tuesday at ten" twice in the same minute. Here the model never books anything: it
calls tools that walk `availability → hold → confirm`, where the hold has a TTL and the
confirmation is idempotent, and the whole thing runs inside a transaction that a second
caller loses cleanly.

![Operations console](docs/obrazy/konsola-gotowosc.webp)

<sub>The console after login: adapter readiness, the transactional booking rehearsal, and
the pilot gate — "connection to the market, 1 of 4 ready". You cannot point a phone number
at it until that gate is green.</sub>

---

## Demo

**There is no public demo, deliberately.** The product answers telephone calls. A public
demo means publishing a phone number anyone can run up a bill on, and a booking calendar
anyone can fill with rubbish.

What you can do instead — a full local instance in about two minutes:

```bash
git clone https://github.com/piatekkrzysztof/Voice-reception.git
cd Voice-reception
cp .env.example .env
npm start
```

Open `http://127.0.0.1:4173`. On first run the console asks you to create an owner
account: **there is no default login or password**, and the password is stored only as a
`scrypt` hash. After that everything in the screenshot above is live — including the
booking rehearsal, which walks the real `availability → hold → confirm` path against the
local calendar adapter.

Local mode needs nothing external: no Vapi account, no Cal.com, no API keys. It also does
not answer real telephones. For that you need a Vapi assistant, a number, a calendar and
public HTTPS — the procedure is in [`docs/VOICE_PILOT.md`](docs/VOICE_PILOT.md).

On Windows, `./start.ps1` instead of `npm start`.

---

## Architecture

```mermaid
flowchart TB
    caller["Caller"]
    vapi["Vapi<br/>speech and telephony"]

    subgraph app["Voice Reception (Node.js)"]
        webhook["webhook<br/>shared-secret auth"]
        gateway["Tool Gateway<br/>check_availability<br/>create_booking_hold<br/>confirm_booking<br/>cancel_booking"]
        service["service.mjs<br/>booking rules"]
        console["operations console<br/>HttpOnly session"]
        webhook --> gateway --> service
        console --> service
    end

    subgraph store["Storage"]
        sqlite[("SQLite<br/>local mode")]
        pg[("PostgreSQL<br/>pool and migrations")]
    end

    kalendarz["Calendar<br/>local adapter or Cal.com v2"]

    caller <--> vapi
    vapi --> webhook
    service --> sqlite
    service --> pg
    service --> kalendarz
```

The model is never trusted with state. It can call four tools, each returning a strict
`result` contract; the booking rules, the conflict checks and the transaction all live on
this side of that boundary.

---

## Key technical decisions

**One runtime dependency.** `package.json` lists exactly one: `pg`. Sessions, password
hashing, HTTP, SQLite and the test runner are Node built-ins (`node:crypto`,
`node:sqlite`, `node:test`). For a system holding customers' names, phone numbers and
appointment times, every transitive dependency is supply-chain surface — and this one has
almost none.

**Signed slots, holds with a TTL, idempotent confirmation.** A voice agent repeats tool
calls when the line stutters or the caller says "yes" twice. Confirmation is therefore
idempotent: the same hold confirmed twice yields one booking, not two. Slots are signed so
the agent cannot invent a time that was never offered, and holds expire so an abandoned
call does not block the calendar forever.

**The race is tested against a real PostgreSQL, not a mock.** The test that matters most —
two callers going for the same slot — runs against an actual database with actual
transactions, because a mocked transaction proves nothing about isolation. It skips by
default and runs when `TEST_DATABASE_URL` is set; CI always sets it.

**SQLite locally, PostgreSQL in production, one interface.** Local development needs no
container and no setup; deployment gets a pool, migrations and real transactional
guarantees. Both implement the same module contract, so the booking logic does not know
which one it is talking to.

**A readiness gate before the phone rings.** The console refuses to look production-ready
when it is not. It shows each dependency — database, telephony, calendar, public edge,
webhook auth — as ready or not, and counts how many of the four steps to "connected to the
market" are done. Pointing a real number at a half-configured system is how a business
loses a customer at eight in the morning.

**AI disclosure mandatory, transfer always available, recording off.** Not configurable.
The assistant says it is automated at the start of the call, a human is one request away,
and calls are not recorded — only the final report is stored.

**No default credentials, ever.** First run creates the owner account interactively. If
that first run happens over a public address it additionally requires a long random
`VOICE_SETUP_TOKEN`, so an exposed instance cannot be claimed by whoever finds it first.

---

## Tests

```bash
npm test                                     # SQLite only; the PostgreSQL test skips
TEST_DATABASE_URL=postgres://… npm test      # everything
```

The runner is Node's built-in `node --test`. No Jest, no Vitest, no configuration file.

### Current results

| | |
|---|---|
| Tests | **15 passing**, 0 failing (measured with `TEST_DATABASE_URL` set) |
| Without a database URL | 14 passing, 1 skipped — the PostgreSQL race test |
| Runtime | ~1.2 s |
| CI | SQLite suite · real PostgreSQL transaction test · production image build |
| Coverage | not measured |
| Lint / format | not configured |

They cover environment and readiness rules, booking rules, hold expiry, the double-booking
race under a real transaction, the Cal.com v2 adapter contract (including the pinned slots
API version), the Vapi Tool Gateway `result` contract, and webhook authentication.

A throwaway PostgreSQL for the full run:

```bash
docker run -d -e POSTGRES_PASSWORD=test -e POSTGRES_DB=voice_test -p 55433:5432 postgres:16-alpine
TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/voice_test npm test
```

---

## Security model

**No default credentials.** The owner account is created on first run, stored as a `scrypt`
hash only, minimum twelve characters. A public first run additionally requires
`VOICE_SETUP_TOKEN`.

**Sessions are `HttpOnly` cookies with expiry**, not tokens in JavaScript-readable storage.
Failed logins are rate-limited.

**Every endpoint carrying customer data or booking operations requires an active session.**
The Vapi webhook is separate, authenticated by shared secret, and stores only the final
call report.

**Calls are not recorded.** Only the outcome is persisted. A decision, not a setting.

**Records are separated by `tenant_id`** in the PostgreSQL schema — preparation, not
multi-tenancy; see the pilot boundary below.

**HTTPS is automatic** in the Docker deployment, through Caddy.

Detail in [`docs/SECURITY.md`](docs/SECURITY.md). Report a vulnerability to
krzysztof@agencjasm-art.pl rather than opening a public issue.

---

## Known limitations

**The pilot boundary.** PostgreSQL is ready for a single deployment and separates records
by `tenant_id`. Before this is a real multi-tenant SaaS it needs row-level security, a
central identity provider with MFA and roles, an event queue, monitoring, automated
backup, a retention policy and a tenant configuration screen. None of those exist yet, and
`tenant_id` on its own is not isolation.

Beyond that:

- **15 tests is a floor, not a suite.** They cover the rules that matter most, but there
  are no contract tests against a recorded voice session, none for a repeated webhook,
  none for a call dropped between hold and confirm, and none for retry or overload.
- **No linter or formatter**, no coverage measurement, no dependency scan in CI.
- **Local mode does not answer telephones.** Everything is exercisable except the thing
  the product exists for; that needs external providers.
- **One migration.** The schema has barely evolved, so the migration path is untested in
  practice.
- **Two commits.** The history carries no decision trail. From here on, changes go through
  an issue, a branch and a pull request.
- **No latency measurement.** A voice agent has a hard latency budget — a caller notices a
  second of silence — and it has never been measured.

---

## Roadmap

**Now — the tests these failure modes deserve.** Contract tests against recorded voice
sessions, booking idempotency under repeated tool calls, a repeated webhook, a call
dropped between hold and confirm, and behaviour under retry or overload. ESLint, Prettier,
coverage and dependency scanning in CI.

**Next — latency and cost as numbers.** Time to first response and p95 across the whole
`availability → hold → confirm` path, plus the cost of one booked call. A voice product
lives or dies on both.

**Then — the pilot boundary,** in the order the items block a second customer: row-level
security, backups with a tested restore, retention policy, monitoring.

---

## Deployment

```bash
cp .env.production.example .env.production
docker compose --env-file .env.production up --build -d
```

Node.js 24 and PostgreSQL in containers, automatic HTTPS through Caddy. The full
procedure — DNS, secrets, readiness, migrations, backup — is in
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). Connecting the voice provider is in
[`docs/VOICE_PILOT.md`](docs/VOICE_PILOT.md); once `.env` is filled,
`npm run voice:sync` creates or updates the Vapi assistant.

---

## Repository layout

```
public/                          the operations console (one page, no framework)
server.mjs                       HTTP API and Vapi webhook
src/config.mjs                   environment and readiness rules
src/auth.mjs                     scrypt passwords, sessions, rate limiting
src/voice/service.mjs            booking logic and Tool Gateway
src/voice/database.mjs           transactional SQLite model
src/voice/postgres-database.mjs  PostgreSQL, pool, transactions
src/voice/calendar.mjs           local calendar and Cal.com
src/voice/assistant-config.mjs   Vapi assistant configuration
migrations/                      versioned PostgreSQL schema
test/                            domain and contract tests
docs/                            architecture, deployment, security, pilot
```

Reset the local database, with the server stopped: `npm run reset`.

---

## Licence

**Source-available. All rights reserved.**

Copyright © 2026 Krzysztof Piątek (SM-art).

Published to be read and reviewed. Not licensed for reuse: no copying, modification,
distribution, self-hosting or operation, in whole or in part, without written permission.

Reading and discussing the code is welcome — krzysztof@agencjasm-art.pl.
