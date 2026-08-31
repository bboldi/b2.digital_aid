// Wire protocol generation. PROTOCOL.md is the authority — bump both together.
// Advisory only: a mismatch is logged and badged in the admin UI, never fatal.
export const PROTOCOL_VERSION = 5;

// Documented ping statuses (PROTOCOL.md §7.1). Used to *flag* unknown values,
// never to rewrite them — the ping log is the parent's evidence, and substituting
// a plausible status for an unrecognised one fabricates it.
export const PING_STATUSES = new Set(['active', 'locked', 'blocked', 'grant-active']);

// Which ping statuses count as Usage Time: the machine was logged in, unlocked and usable. Defined
// once and shared by the Client Page (daily.js), the Clients grid (ws.js) and the Daily Summary
// rollup (rollup.js) — the same day must not mean different things depending on which screen you
// are looking at, and a rolled-up day cannot be recomputed if they drift.
export const USABLE_STATUSES = new Set(['active', 'grant-active']);
