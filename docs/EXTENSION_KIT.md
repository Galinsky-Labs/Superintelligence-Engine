# Provider adapter certification kit (SIE-040, partial)

`packages/engine/src/certify.mjs` encodes the behavioural contract an adapter must meet before it is added to
`PROVIDERS` (`packages/engine/src/providers.mjs`):

| Rule | Why |
|---|---|
| Chat streams `text` events, exactly one `usage` event with integer token counts, then `done` naming the served model | Budget settlement needs exact usage; the run log needs the served model |
| An aborted signal raises `ProviderError('cancelled')` | Run cancellation must stop spend immediately |
| Tool calls carry an id, a declared tool name and an object input | The executor validates and audits every tool call |
| Structured output is parseable JSON | Structured nodes validate against their schema |
| HTTP 401/429/503 become typed `ProviderError`s with correct `retryable`, and the message never contains the credential | Retries and backoff; errors are persisted in runs and logs |
| Media methods return non-empty bytes, an `image/*`/`audio/*`/`video/*` type and positive `units` | Asset storage and unit-priced metering |

Run it: `npm run certify:adapter` (built-in simulator) or `npm run certify:adapter -- my-adapter.mjs --model <id>`,
where the module default-exports `{make({apiKey,baseUrl,fetchImpl}), model, media}`. A real key (`CERT_API_KEY`) makes
live calls and may cost money; the error checks always use a fake transport.

The kit found that provider error bodies echoing an API key were copied into `ProviderError` messages (and from
there into run records and logs); `httpError` now redacts the adapter's credential.

Certification here means conformance to this engine's adapter contract only — not provider quality, pricing, terms
or an external audit. Still to do for SIE-040: a published extension package template, plugin manifest signing and
a certification registry.
