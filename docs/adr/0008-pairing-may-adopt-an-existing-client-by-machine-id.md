# Pairing may adopt an existing Client by machine ID

Pairing used to create a new [[Client]] every time, unconditionally — `/api/pair` received a code, a name and a protocol number, and nothing that could identify the machine sending them. The rule was deliberate and written into the glossary: no machine fingerprinting, stale Clients deleted by hand. In practice it turned an ordinary accident into permanent data loss. A PC whose state file was lost re-paired as a stranger, and its months of Pings, Events and [[Daily Summary]] rows stayed behind on a row that would never report again, next to an identically-named row that had no history at all. Nothing in the admin UI could put them back together, and the two are indistinguishable from a genuine second PC.

The Client now sends a stable machine ID at pairing — the Windows `MachineGuid`, which survives reinstalling the app and losing state, and changes when the machine is reimaged. If the server already knows a non-revoked Client with that ID, pairing **offers** to reconnect to it: the existing row keeps its history, settings and name, and its `token_hash` is overwritten with the new token, which invalidates the old one as a side effect. Declining sets up a genuinely new Client, as before.

Two properties make this safe enough to reverse the old rule. The machine ID is **not a credential** — a valid [[Admin Code]] is still required, and the ID only decides *which* Client the code applies to; on its own it grants nothing. And adoption is **never silent**. Cloned VMs and reimaged PCs can share a `MachineGuid`, and a silent match would quietly fuse two real machines into one [[Allowance]] with no visible cause and no obvious way to diagnose it. The parent is standing at the keyboard holding the code at exactly that moment, so asking costs one tap and removes the entire class of failure.

The alternative was to leave pairing alone and add a merge tool to the admin UI. It was rejected as paying twice for one problem: merging is not a matter of repointing rows, because events carry a per-Client sequence that both rows start at 1 and `daily_usage` is keyed per Client and date, so the changeover day collides. That is a renumbering pass, a fold rule, a choice of surviving name and settings, and an irreversible cross-table rewrite behind a confirm dialog — real work for an operation that adoption prevents from ever being needed again.

## Consequences

A reimaged PC no longer matches and pairs fresh, which is correct: it is a different installation, and its old history stays visible under a Client that has stopped reporting. Cloned VMs *will* match, and the prompt is the only thing standing between that and a silent merge — so the prompt must name the existing Client and when it was last seen, not merely ask yes or no.

The machine ID is stored in the clear and is not secret; it identifies a PC to a server that already knows far more about it. It is never accepted as proof of anything.

Duplicates created before this change are not repaired by it. The one existing pair is being fixed with a one-off script rather than a feature, on the grounds that adoption makes it the last one.
