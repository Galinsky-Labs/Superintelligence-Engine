# Studio documents (SIE-024 … SIE-029, SIE-033)

Studio documents are versioned JSON artifacts (`application/vnd.sie.<kind>+json`) with a strict schema per kind.
Every save — through `/v1/projects/:pid/studio` or the generic artifact API — is validated (`packages/engine/src/studio.mjs`),
so history, restore, export and provenance work exactly as for any artifact. The console's **Studio** tab edits them.

| Kind | Unit | Model | Operations |
|---|---|---|---|
| `image-board` | SIE-024 | items with prompt, image artifact, `parentId` (variation tree, cycle-checked), optional rectangular mask (fractions) and pin | `POST …/variations {itemId|prompt,count≤4,mask}` starts an image run (mask becomes a region instruction); `POST …/attach {runId,itemId}` adds the produced images as children |
| `multitrack` | SIE-025/026 | tempo, metre, sections (bars), tracks (role, gain, mute/solo, sections played, stem artifact) | `GET …/export` mix plan (section timing from tempo, audible tracks with solo-over-mute, missing stems); `POST …/stems {trackId}` renders an isolated stem of the right length; `POST …/stems/attach` |
| `timeline` | SIE-027/028 | fps, storyboard shots, video/audio/caption tracks with non-overlapping clips | `GET …/export` frame-accurate cut list (missing media listed); `?format=srt` / `?format=vtt` captions |
| `notebook` | SIE-033 | python cells (markdown/code) with outputs and execution counts | `POST …/run {cellId?}` runs all code cells up to the cell in one fresh sandbox (reproducible), stores per-cell output as a new revision; 503 `sandbox_unavailable` where execution is disabled (e.g. Render free) |

**Code editor (SIE-029):** the Code tab upgrades its textarea to Monaco 0.52.2 loaded from jsDelivr (pinned version;
the console CSP allows only that host for scripts/styles/fonts and `blob:` workers). If the CDN is unreachable the
plain textarea keeps working. `test/ui/monaco.test.mjs` serves the CDN from `node_modules` to verify it offline.

Not yet: true pixel masks/inpainting with provider mask APIs, audio mixdown rendering, video rendering of the cut
list, SQL notebooks and language servers.
