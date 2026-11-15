# Deploying on Render + Neon

`render.yaml` describes a single Render web service (`runtime: node`, worker inline) backed by a Neon
PostgreSQL project. The start command is `npm run start:production`, which runs
`scripts/prepare-production.mjs` and then the API:

1. **Migrations** with `DATABASE_URL` — the Neon owner role (a non-superuser with `CREATEROLE`) on the
   **direct** host. Do not use the `-pooler` host: the API relies on `LISTEN/NOTIFY` and on a
   per-connection `sie.system` setting, neither of which survives transaction pooling.
2. **RLS application role**: with `SIE_APP_DB_PASSWORD` set, the role `SIE_APP_DB_ROLE` (default
   `sie_app`, `NOSUPERUSER NOBYPASSRLS`) is created or its password updated, and the API derives
   `APP_DATABASE_URL` from `DATABASE_URL` with that role. Setting `APP_DATABASE_URL` explicitly overrides this.
3. **Bootstrap operator**: with `SIE_BOOTSTRAP_TOKEN` (`sie_` + 30–80 URL-safe characters, e.g.
   `sie_$(openssl rand -hex 32)`) an operator identity and workspace are ensured and the token is
   registered for it (365 days). Changing the variable and redeploying revokes the previous bootstrap token.
   Use it as `Authorization: Bearer …` or paste it into Command Center's sign-in.

Health check: `/ready` (database reachable, migrations applied). `/health` is liveness only.

Migration 017 matters on managed PostgreSQL 16+: an owner that creates `sie_tenant_role` implicitly
receives an ADMIN-only membership in it, which the original `sie.is_system()` treated as membership,
silently disabling every system-pool query (`db/test/managed-owner.test.mjs`).

## Free-plan limits
- Code execution is disabled (`SIE_SANDBOX=disabled`): Render containers do not allow the user
  namespaces bubblewrap needs. Code workspaces still store files and Git history.
- `SIE_STORAGE_DIR` is ephemeral; configure `SIE_S3_BUCKET`/`SIE_S3_REGION`/`SIE_S3_ENDPOINT` (+ keys) for durable assets.
- Free instances sleep when idle; the inline worker resumes runs after wake-up (leases expire and recover).

## Real models and spending
Without provider keys only the deterministic simulator is offered (`SIE_ENABLE_TEST_PROVIDER=1`, every output
labelled `SIMULATED`, $0). After adding e.g. `ANTHROPIC_API_KEY`, raise the operator cap, which starts at $0,
from any machine that can reach the database: `DATABASE_URL=… npm run admin -- set-global-cap 25`, then
`npm run admin -- fund-tenant <tenantId> 10`.
