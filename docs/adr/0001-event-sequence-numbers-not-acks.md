# Event sequence numbers, not acknowledgements

Events are queued on the Client while offline and flushed on reconnect, but the server never acknowledged a batch — so a socket death mid-flush left the Client unable to tell what had landed. We gave every Event a per-Client monotonic `seq`, put `UNIQUE(client_id, seq)` on the events table, and insert with `INSERT OR IGNORE`. Re-delivery is now free: the Client re-sends its whole queue after any failure without reasoning about what survived. `hello` carries the server's `lastSeq` so a Client can resync its counter after partial state loss.

## Considered options

- **Accept duplicates.** Cheapest, and consistent with "simple over robust" — but the timeline *is* the product. A doubled `unclean-exit` stripe is the parent misreading what happened on their kid's PC, which defeats the purpose of the log.
- **`events-ack {through: seq}`.** Correct, but adds a stateful handshake, and the ack itself can be lost — so idempotent inserts are needed underneath it anyway. It is sequence numbers plus a round trip, not an alternative to them.
- **Sequence numbers (chosen).** One integer on the wire, one unique index in the schema.

## Consequences

The dangerous case is a Client that keeps its `client_id` but forgets its counter: resetting to `seq: 1` would have its genuinely new Events silently swallowed as duplicates, and silent loss in the audit trail is the one outcome this system must not have. Two things prevent it. The Client Token and `next_seq` live in the same state file, so total loss un-pairs the Client and re-pairing allocates a fresh `client_id` with a clean sequence space. Partial loss — a truncated state file after a power cut — is repaired by `lastSeq` in `hello`, which the Client takes the max of on every connect.
