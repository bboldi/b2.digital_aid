# Language is chosen on the Client, not pushed from the server

Everything a [[Client]] obeys comes from the server. [[Allowance]], [[Downtime]], [[Lock]], [[End Today]], the [[Block Screen Background]] — the Client is told, and the Client complies. Language is the one setting that breaks the pattern: it is picked from a submenu in the tray, on the machine, by whoever is sitting at it. The server cannot set it and cannot see it.

The pattern exists for a reason, and the reason does not reach this far. Everything the server owns is policy the kid must not control — that is the whole point of putting it behind the [[Admin Code]] and a login. A kid switching their own UI to Hungarian defeats nothing, reveals nothing, and buys them not one extra minute. There is no authority to spend here, so spending it would be habit rather than judgement.

Two things settled it beyond preference. The first is that a server-pushed language could not be the only one anyway: the pairing dialog, and the whole [[Unconfigured]] state described in [ADR-0007](./0007-a-client-without-a-family-code-secret-enforces-nothing.md), are visible on a Client that has never spoken to a server and has no settings to obey. Something local has to answer before the server exists. Adding a pushed setting on top of that does not replace the local one — it adds a second answer, and with it a precedence rule.

The second is what that precedence rule would have to be, either way round. If the server wins, the tray submenu is a lie: the kid picks English, and the next `hello` silently puts it back. If the Client wins, the server's setting is a suggestion it can never confirm was taken, shown on a page that is meant to be the truth about the machine. One value with two owners is worse than either owner alone, and neither reading is defensible on a screen a parent trusts.

So there are two settings that merely sound like one. The server's is the language of the admin UI, held on the `admin` table, and it belongs to the parent's browser. The Client's is the language of that PC, held in its state file. They never synchronise, and a household running the parent's phone in Hungarian and a kid's PC in English is a configuration, not a defect.

## Consequences

The choice is stored as a bare `en` or `hu` and is a concrete value, never "follow the system". The system language is consulted exactly once, on first run, to pick the starting value; after that the stored choice wins forever. A tri-state would mean a Client's language could change under a kid's feet when someone touched the Windows display language, and would leave the submenu's checkmark unable to say what is actually in force.

A parent cannot fix a wrong language on a kid's PC from their phone. Accepted: it takes one right-click at the machine, and the alternative was a second source of truth for a value that enforces nothing.

The server keeps no record of what language any Client is displaying, so the Client Page cannot show it. That is a consequence of the Client owning it and is not worth a protocol field to undo.

Nothing about this changes what crosses the wire, because the wire was already right. The server sends structured verdicts, and the sentences a kid reads are composed in `Client.Core` from that data — so the two sides never had to agree on a language to begin with. The one piece of server-authored text a kid ever sees is a parent's typed message, which is a human writing to another human and is never translated in either direction.
