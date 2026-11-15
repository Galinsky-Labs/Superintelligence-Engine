# Threat model (SIE-036) — AI-assisted, not an independent review

Scope: the engine API and console, worker, PostgreSQL schema, provider adapters, tool/egress layer, code sandbox,
asset storage, and the two companion apps as API clients. External human security review remains pending
(owner policy, 2026-10-13); this document and its tests are the AI-assisted review.

## Assets and trust boundaries
| Asset | Boundary | Primary controls | Evidence (tests) |
|---|---|---|---|
| Tenant data (projects, artifacts, runs) | API ↔ tenant pool | Bearer tokens (hashed), membership + role checks, PostgreSQL FORCE RLS with a NOSUPERUSER/NOBYPASSRLS app role; `sie.is_system()` cannot be claimed by the tenant role | `db/test/integration`, `db/test/managed-owner`, `test/e2e/security-regressions`, `test/e2e/production-prepare` |
| Provider credentials | DB at rest, adapters | AES-GCM `SecretBox`, fingerprints only in responses, redaction of keys echoed in provider errors | `packages/engine/test/certify`, `test/e2e/providers-budget` |
| Money (provider spend) | Budget ledger | Global cap (default $0) → tenant funding/limit → per-run ceiling → workspace policy cap; reserve worst case before every paid call, settle actual | `db/test/budget`, `test/e2e/providers-budget`, `test/e2e/governance-status` (load trial reconciles spend) |
| Host | Code sandbox | bubblewrap, no network, per-run tmp, path hardening (`.git/config` RCE fix) ; disabled on Render | `test/e2e/tools-security`, `test/e2e/security-regressions` |
| Internal network | Tool egress | SSRF guard (private ranges, redirects re-checked), allow-list, approvals for external/publish/deploy/financial/delete effects bound to the exact request | `test/e2e/tools-security` |
| Uploaded files | Asset store | content-type sniffing, size caps, optional ClamAV, `Content-Security-Policy: sandbox` on downloads | `test/e2e/vertical` |
| Browser sessions | Console / companion apps | Console CSP (scripts from self + pinned Monaco host only), companion apps are BFFs (token sealed server-side, cross-site writes refused) | `test/ui/monaco`, companion `engine-e2e` tests |
| Administrative actions | Governance | Owner-only policy, admin-only audit log (member, credential, budget, project deletion, approvals, tool decisions), seat limits | `test/e2e/governance-status` |

## Top threats and status
1. **Cross-tenant read/write** — mitigated by RLS + role checks; regression-tested.
2. **Prompt-injected tool misuse** — effects needing approval pause the run; approvals are bound to a request hash; tool calls audited.
3. **Runaway spend** — cap at $0 by default, reservations before calls, workspace run cap; spend alert rule in `ops/prometheus-alerts.yml`.
4. **Credential disclosure** — encrypted at rest; never returned; redacted from provider errors (found and fixed in #44).
5. **Sandbox escape** — bubblewrap without network; execution disabled where user namespaces are unavailable.
6. **Supply chain (CDN)** — only `cdn.jsdelivr.net/npm/monaco-editor@0.52.2` is allowed by CSP; pinned version; textarea fallback. Residual risk: no SRI for Monaco's AMD-loaded modules.
7. **Denial of service** — per-identity and public rate limits, body size limits, run node caps, tenant concurrency limit.

## Open items
- Independent external review and penetration test (deferred by owner policy; not a release blocker).
- SRI/self-hosting for Monaco; WAF/edge rate limiting on Render; per-tenant storage quotas.
