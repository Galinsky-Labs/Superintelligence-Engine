# Superintelligence Engine

The shared AI engine behind **Superintelligence Academy** and **Superintelligence Command Center**:
authenticated multi-tenant projects and versioned artifacts, real provider execution with streaming and
budget enforcement, durable multi-agent orchestration, permission-controlled tools (MCP, external agents,
HTTP, Git), domain workspaces, an isolated code-execution sandbox, and a web console.

## Run it locally

Requirements: Node 22+, PostgreSQL 15+ (or the PostgreSQL server binaries; `dev.sh` starts a private
cluster), and `bubblewrap` for the code sandbox (`apt install bubblewrap`).

```bash
npm install --ignore-scripts
```

```bash
npm run dev
```

Open http://localhost:8080/app/, sign in with any development handle, create a project.
`npm run dev` applies migrations, creates the non-superuser `sie_app` role (so row-level security is
enforced), generates a local encryption key under `var/`, and runs the API with an inline worker.
With no provider keys it offers only the deterministic **simulator** — every simulated output is
labeled `SIMULATED` and costs $0.

To use real models, put keys in `.env` (see `.env.example`) and raise the spending caps, which start at $0:

```bash
npm run admin -- set-global-cap 25
```

```bash
npm run admin -- fund-tenant <tenantId> 10
```

Docker alternative (PostgreSQL + API + separate worker): `cp .env.example .env`, fill `SIE_ENCRYPTION_KEY`, then `docker compose up --build`.

## What it does

| Capability | Where |
|---|---|
| Identity: API tokens (hashed), OIDC SSO sessions per product, dev login (non-production only), tenants, roles owner/admin/member/viewer | `packages/engine/src/identity.mjs`, `packages/auth` |
| Projects, artifacts with full revision history, optimistic concurrency, restore, download, export/import with checksums, binary assets with content verification (optional ClamAV) | `projects.mjs`, `assets.mjs` |
| Providers: Anthropic (official SDK), OpenAI, any OpenAI-compatible endpoint, Google Gemini, ElevenLabs, Replicate (async), deterministic simulator. Streaming, tool calls, structured output, images, speech, transcription, music, video, model discovery | `providers.mjs`, `models.mjs`, `catalog.mjs` |
| Budgets: operator-wide cap + tenant funding/limit + per-run ceiling; every paid call reserves its worst case first, then settles actual usage; usage recorded per call | `catalog.mjs` (`Meter`), `packages/budget` |
| Multi-agent runs: DAG of agents/planners/tools/approvals/code/media/external agents, conditions, template data passing, planner delegation that spawns agents at runtime, concurrency, leases + heartbeats, crash recovery, retries with backoff, checkpoints, cancellation, idempotent submission, live SSE event replay | `runs.mjs`, `executor.mjs`, `Worker` in `index.mjs` |
| Tools: project artifacts, workspace files, sandboxed code, calculator, web fetch (egress-guarded), HTTP requests, Git commit/push, MCP servers, A2A external agents. Effects `external/deploy/financial/publish/delete` always pause for an admin approval bound to the exact request; all calls audited | `tools.mjs`, `connections.mjs`, `net.mjs` |
| Domain workspaces: research (brief, deep multi-agent), writing (poem, persuasive, fiction, revise), legislation (draft, analyze), code (build, review), data analysis, image, music, video, voice (speak, transcribe), cross-media campaign | `domains.mjs` |
| Code workspace: persistent files with history, isolated execution and tests, diagnostics, Git log/diff/checkout, signed sandboxed previews | `workspace.mjs`, `sandbox.mjs` |
| Scheduled and conditional workflows (cron with time zones, run-on-artifact-change) | `scheduler.mjs` |
| Operations: `/health`, `/ready`, Prometheus `/metrics`, structured JSON logs with request ids, error webhook, graceful shutdown | `apps/api/src/server.mjs`, `infra.mjs` |
| Console UI for all of the above | `apps/console/public` |
| Client SDK for Academy / Command Center | `packages/sdk` |

API reference: `contracts/openapi.json` (generated from the route table). Every tenant-scoped call needs
`Authorization: Bearer <token>` (or an SSO session cookie from a registered product origin) and `X-Tenant-Id`.

```js
import {EngineClient} from '@superintelligence/sdk';
const engine=new EngineClient({baseUrl:'https://engine.example',token:process.env.SIE_TOKEN,tenantId});
const project=await engine.createProject({title:'Course: Ecology',kind:'research'});
for await (const ev of await engine.generateStream(project.id,{prompt:'Outline week 1'})) if(ev.event==='token') process.stdout.write(ev.data.text);
const run=await engine.runOperation(project.id,'research.deep',{question:'How do wetlands store carbon?'});
for await (const ev of await engine.followRun(run.id)) console.log(ev.event);
```

### Workflow format

```json
{"title":"Study","inputs":{"topic":"tidal energy"},"budgetCeilingMicro":2000000,"nodes":[
  {"key":"plan","type":"planner","instructions":"Investigate {{inputs.topic}}","maxTasks":6,"worker":{"tools":["research"]}},
  {"key":"gate","type":"approval","dependsOn":["plan"],"effect":"publish","summary":"Publish the report?"},
  {"key":"post","type":"tool","dependsOn":["gate"],"tool":"http_request","args":{"method":"POST","url":"https://hooks.example/report","body":"{{nodes.plan.synthesis.text}}"}}
]}
```

Node types: `agent` (instructions, role, model, tools, outputSchema, maxSteps), `planner` (delegates to
spawned agents + synthesis), `tool`, `approval`, `code` (sandbox), `media` (image/speech/music/video/transcribe),
`external_agent`. Any node: `dependsOn`, `when` (`{node,path,op,value}` / `all` / `any` / `not`),
`maxAttempts`, `optional`.

## Security model

* Tenant data is filtered in application code **and** by PostgreSQL row-level security: user-scoped queries
  use a non-superuser role with `sie.tenant_id`/`sie.identity_id` bound per transaction; trusted engine
  services use a separate pool flagged `sie.system`.
* Provider keys and integration secrets are stored AES-256-GCM encrypted and are never returned by the API.
* Untrusted code runs in bubblewrap namespaces (no network, read-only system, private /tmp and /proc,
  per-execution unprivileged UID, memory/CPU/process/file-size limits) or Docker; without either, execution is refused.
* Outbound tool traffic is HTTPS-only, blocks private/link-local/metadata addresses, re-validates redirects,
  and is bounded in size and time. Hosts outside `SIE_EGRESS_ALLOWLIST` require approval.
* Consequential tool effects require an admin/owner approval of the exact request hash; approvals are single-use.
* Browser access is limited to the registered Academy/Command Center origins (plus same-origin console);
  cookie-authenticated writes require a registered Origin.
* Review status: AI-assisted review and automated adversarial tests only. Independent human security review
  remains pending (see `AGENTS.md`, `security/`).

## Tests

```bash
TEST_ADMIN_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres npm test
```

Integration tests create and drop a fresh database per file. Provider tests run against local servers
that speak each provider's wire protocol — they prove protocol handling, not live-model behavior.
`test/ui` drives the console in Chromium via Playwright when it is installed.

## Production deployment

Run `node scripts/migrate.mjs`, `node scripts/setup-db-roles.mjs sie_app <password>`, then the API
(`npm start`) and one or more workers (`npm run start:worker`) with the same `DATABASE_URL`,
`APP_DATABASE_URL`, `SIE_ENCRYPTION_KEY` and a shared persistent `SIE_STORAGE_DIR`. Set `NODE_ENV=production`
(disables dev login), OIDC settings, product origins, and provider keys. Workers scale horizontally;
concurrency per worker is `SIE_WORKER_CONCURRENCY`.

Current deployment state: no hosted deployment is configured (inventory-only manifest, $0 operating budget).
