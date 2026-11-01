# SIE-013 — structured generation, citations and scoped tool proposals

This is a server-side composition over the existing funded text-generation,
project-artifact and scoped MCP services. It does not enable a public endpoint,
issue consent, deploy infrastructure or make any paid call by default.

## Trusted integration

1. Authenticate the actual user and select the tenant using the existing session
   boundary. Construct `{tenantId, identityId}` from that verified session.
2. Call `retrieveCitedSources({gateway, principal, resources})` with an installed
   `ScopedMcpGateway` and server-selected exact resource references. Its existing
   user grant, expiry/revocation, read-only scope, egress and audit checks apply.
   Returned documents remain untrusted data. Never interpret them as tool grants.
3. Install `createStructuredGenerationService({pool, providers, pricing,
   dispatchEnabled, principal, sources, schema, allowedTools})` in trusted code.
   The principal, source inventory, schema and allowed tool schemas are captured;
   they are not accepted from a model's instructions. Keep the service scoped to
   that principal/source inventory, rather than sharing it across tenants.
4. Invoke its `generate` with the existing authenticated context, project,
   funded reservation, configured provider, operation and prompt arguments.
   Complete prompt/schema/source overhead counts against the existing conservative
   input and cost ceilings. Reservation identity includes the installed policy
   digest. Reuse with a different prompt/schema/source/principal cannot dispatch
   another paid call under that reservation.
5. For a verified compatible OpenAI model, explicitly construct its existing
   `OpenAIResponsesTextAdapter` with `structuredOutputs: true`. The default is
   false; unknown model support never silently falls back to unconstrained text.
   The adapter sends `text.format` with `type: json_schema` and `strict: true`,
   keeps `store: false`, and does not expose provider function tools.

The provider format was checked against the official Responses structured-output
documentation on 2026-10-17:
https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses
This request-shape check and synthetic transport tests do not prove live account
access, every model's schema support, pricing, or a paid production generation.

## Validation and persistence

The result envelope requires `data`, `citations` and `toolCalls`. Each tool proposal
contains `connectionId`, `toolName` and `argumentsJson`; it never contains authority.
Every object is closed and all declared properties are required. Supported schema
types are object, array, string, number, integer, boolean and null; scalar enum,
string/array length bounds and numeric bounds are supported. References, regexes,
combinators, unknown keywords and open property bags fail closed at installation.
This is a documented restrictive JSON Schema subset, not a general validator.

Limits include 16 source resources (64 KiB each, 128 KiB total before tighter JSON
policy limits), 16 tool types/proposals, 64 citations, 200 array values, schema
depth 10/nodes 200/16 KiB, JSON depth 16/nodes 10,000/125,000 bytes. Policy JSON
and final artifact/prompt bounds may reject a combination below individual limits.
Duplicate keys (including escaped aliases), prototype-sensitive keys, nonfinite
or unsafe integral numbers, trailing data and malformed JSON are rejected.
No automatic repair, retry, schema coercion or ignored unknown rules occur.

Structured token fragments are not passed to `onToken`. Only a fully validated
envelope may reach `ProjectService.createArtifact`, as `application/json` with
its actual body hash, immutable source metadata inventory and policy digest.
The artifact inventory omits complete source text: it retains identifiers,
principal scope, URI and content hash. Full text remains in the principal-bound
validation snapshot and selected exact citation quotes remain explicit output.
This prevents project exports from silently copying all uncited retrieved text. The real
provider usage/receipt, reservation fencing and replay behavior remain in force.
If validation fails after dispatch, no artifact is written; the existing dispatch
is `needs_reconciliation`, the reservation remains held and replay cannot generate
again. Operators must reconcile actual provider usage; rejection is not a claim
that the provider incurred no cost. No provider error text or source text is added
to failure messages/audit callbacks.

## Citation and tool guarantees

Citation IDs must exist in the principal-bound source snapshot, and quotations
must be exact substrings of that snapshot. Source hashes and source identifiers
are deterministic. Server-derived coverage counts distinct cited sources and
warns on missing citations or unused sources. A text match does **not** prove
semantic support, completeness, truth, legal validity or calibrated confidence;
explicit warnings preserve those distinctions.

Generation never executes proposals. A separately invoked, trusted server handler
may call `executeApprovedToolProposal` with its own installed allowlist. It checks
the exact tool and recursively validates arguments, then delegates to the real
gateway, which rechecks current revocable user consent and network/effect gates.
Do not expose the helper as an unrestricted public endpoint or accept its
`allowedTools`/`principal` from generated text. External-effect tools remain denied
by the existing gateway until a separate per-action approval design is installed.
Retrieved instructions cannot add tools, grant consent or invoke a writer.

## Evidence and remaining acceptance

Focused credential-free tests exercise malformed/duplicate JSON, schemas,
identity-bound sources, forged citations, source injection, tool scopes, current
grant denial and provider wire format/refusal. PostgreSQL CI exercises valid JSON
artifact persistence/billing/replay and proves malformed structure, invented
citations and unauthorized tools create no artifacts or repeat dispatches.
The original plaintext API/SDK/OpenAPI contract remains unchanged.

Product-specific authenticated HTTP/UI exposure, richer search/ranking,
semantic citation review, live compatible-provider acceptance and calibrated
confidence remain separate integration/release work. No external security audit,
deployment, provider invocation or whole-platform completion is asserted.
