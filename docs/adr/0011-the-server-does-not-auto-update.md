# The server does not auto-update

The [[Client]] updates itself. The server does not, and never will on its own. That asymmetry looks like an oversight, so it is written down here: it was considered in full and rejected.

The mechanics were never the obstacle. A restart is already a non-event — events carry a monotonic `seq` and land through `INSERT OR IGNORE` ([ADR-0001](./0001-event-sequence-numbers-not-acks.md)), the Client holds an append-only queue with two-phase take/commit, and reconnection is a solved problem with its own two ladders ([ADR-0009](./0009-two-reconnect-ladders-unreachable-and-rejected.md)). Bouncing the process loses nothing. Schema migration is additive on open, so a newer build upgrades an existing database by itself. `git pull && npm install && restart` in a systemd timer would have worked.

What killed it is what the server *is*. It is the household's authority: it holds the [[Admin Code]] secret and the [[Grant Seed]], decides every [[Client]]'s [[Allowance]] and [[Downtime]], and answers only over a private tailnet. Unattended updating points that machine at a public GitHub repository and tells it to fetch and execute whatever is there, on a schedule, with nobody watching. A compromised account upstream would own every household running it, silently, and the first evidence would be behaviour nobody was present to see.

Set against that, the benefit is convenience alone — and less of it than it first appears, because **a stale server costs almost nothing**. Clients enforce offline from their own state, so a server left a version behind, or down entirely, does not unblock a single PC. The parent loses their dashboard and live commands until they update, and that is the whole of it. There is no failure this would have prevented and no urgency it would have served.

The remaining argument was the unattended update's real one: an update nobody has to remember is an update that actually happens. But this is a single-admin system whose admin is the person who wrote it, the running version is on the About section of the very page they open to check on their kids, and updating is two commands over a tailnet. The version notice does the remembering; the human does the fetching.

## Consequences

Updating the server is manual and stays manual: `git pull`, `npm install`, restart. No update script ships, because a script is how this decision quietly reverses itself — one systemd timer away.

The version number therefore has to be honest about a tree nobody compiled. The server has no build step, so what is running *is* the working tree, and `package.json` alone would happily claim `0.1.4` for a tree three edits past its tag. The running version is derived instead: the `package.json` version, plus `+dev.<sha>` whenever git says the tree is not sitting exactly on its release tag. That is why `server/publish.sh` exists at all despite producing no artifact — the tag is the release, and without one there is nothing for a version to name.

The two halves of the project now version independently, which is correct rather than merely tolerable: `PROTOCOL_VERSION` is the compatibility contract between them, and it always was. Client `0.2.3` talking to server `0.1.1` is not a mismatch to reconcile.
