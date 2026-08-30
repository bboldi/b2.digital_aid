# Pings roll up into a Daily Summary after thirty days

A Ping per minute per Client is ~66 MB/client/year and grows without bound; the PRD's "no retention policy needed for v1" was a v1 decision we are now past. Raw Pings are kept for 30 days, after which a nightly job folds each older day into one `daily_usage` row per Client per date — used minutes, blocked minutes, longest session, and the per-app breakdown as JSON — and deletes the raw rows. Recent days keep their minute-level timeline; older days become a summary that never expires.

## Considered options

- **Do nothing.** Honest answer: viable for years. Rejected only because the growth is unbounded and the fix gets more expensive the longer the table is.
- **Run-length encoding on write** — one row per change instead of per minute, ~50× smaller. Rejected because it destroys the log's defining property. Today a gap means "offline or killed", and that gap *is* the audit trail; under RLE a gap also means "nothing changed", and the two become indistinguishable. Bolting a heartbeat back on to separate them reinvents downsampling with more moving parts and forces a rewrite of the [[Ping]] glossary entry.
- **Downsample to 1-in-5 after N days.** Lossy in a way that is hard to explain to yourself six months later, and it degrades the same property RLE does, just more slowly.
- **Rollup + prune (chosen).** The only option that leaves the write path and the meaning of a Ping row completely untouched. It says minute-level detail has a shelf life; everything above that is kept forever in a form better suited to the questions actually asked about last March.

## Consequences

The `daily_usage` shape is a one-way door: once a day's raw Pings are deleted, a different rollup shape cannot be recomputed from them. That is why the per-app breakdown is stored even though nothing reads it yet — it is the expensive-to-lose part and costs ~200 bytes/day. Changing the horizon later is cheap in one direction only (raising 30 days preserves more; lowering it destroys).

Today's usage is always derived from raw Pings, never from `daily_usage`, so the Client card and Client Page never depend on the nightly job having run.
