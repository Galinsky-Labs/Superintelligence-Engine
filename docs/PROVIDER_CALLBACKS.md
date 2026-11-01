# SIE-018 security primitives, partial

packages/providers/src/callbacks.mjs implements exact-body timestamp-bound
HMAC-SHA256 verification and a deterministic idempotent provider task reducer.
Tests cover tampering, replay window, duplicate callbacks, terminal-before-progress
reordering and cross-task substitution.

These primitives are NOT yet wired to an authenticated webhook route and DO NOT
provide durable transactional deduplication. The in-memory reducer must never be
used directly for charging, publishing assets or release acceptance. Before rollout:
provider-specific signature specification/secret configuration, authentic task-to-tenant
linkage, persistent event-ID uniqueness and terminal transaction with one bill and
one asset disposition, restart/recovery tests and production provider integration.
This increment neither activates a webhook endpoint nor charges users.
