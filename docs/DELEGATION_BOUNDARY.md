# SIE-020: Delegation contract increment

The pure module packages/workflows/src/delegation.mjs calculates a requested
remote scope restricted to both the verified caller grants and independently
discovered remote capabilities. It bounds microcredit budget and expiration,
labels no-remote-persistence and requires a cancellable task contract. It can
form minimal audit event records without passing prompts, credentials or content.

No external agent is contacted and there is NO A2A endpoint, verified peer identity,
authoritative grant lookup, persisted provenance, enforced remote retention or
cancellation delivery. These remain prerequisites for any real delegation.
In particular the caller-provided grant inputs must be provided only by trusted
authorization, never a requester-supplied field. Human approvals remain required
for consequential actions. Tests are in packages/workflows/test/delegation.test.mjs.
