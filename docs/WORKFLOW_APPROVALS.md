# SIE-034 approval state machine (partial)

Pure approval transitions enforce request/approve/start/deny/fail/cancel paths,
version checks and a renewed approval for retried consequential effects.
Denied/cancelled/succeeded states are terminal.

This is NOT a persistent scheduler or live approval authorization. The
actorRole argument must come only from server-verified identity, never the
client. Production requires durable transactional compare-and-swap, signed
approval records, tenant scope, audit events, visual graph editor, bounded
loops/schedules, timer recovery and browser integration. No automation is
started by this code.
