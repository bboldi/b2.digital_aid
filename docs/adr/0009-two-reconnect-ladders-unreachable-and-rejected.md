# Two reconnect ladders: unreachable and rejected

The [[Client]] reconnects forever on one exponential ladder capped at five minutes. That cap was not chosen for the common case; it was chosen for the worst one. A Client whose token has been revoked is closed with `4001` *after* the handshake succeeds, so connecting proves nothing and the backoff never resets — the cap is the only thing standing between a revoked machine and a permanent hammering. Five minutes was the price paid for that, and everyone else paid it: a server restart, an upgrade, or the server PC being switched on in the morning could leave a healthy Client blind for five minutes with the network perfectly fine.

The two situations are not the same answer and should not share a ladder. **No response** means the server is absent and the situation is expected to change, so retrying quickly is correct. **`4001`** means the server is up, reachable, and has said no — and it will keep saying no, because there is no un-revoke: `revoked_at` is set and nothing clears it, and the way back is re-Pairing. Retrying that in five seconds is not cautious, it is pointless.

Unreachable now climbs 5/10/20/30 seconds and caps at **60 seconds**; rejection gets its own ladder capped at **30 minutes**. The 60-second cap costs nothing that was not already being spent: a Client knocking once a minute is knocking at exactly the [[Ping]] rate that every healthy Client already sustains, so a revoked machine is no more load than a live one. Separately, the backoff is abandoned outright when Windows reports the network coming back or the machine resuming from sleep, which covers the cases a ladder cannot: those are instant, and no ladder length can beat them.

Rejection keeps retrying rather than stopping, but not because un-revoke might arrive. It is insurance against `4001` being *wrong* — a database restored from an older backup, a bad deploy — where giving up permanently would mean walking to every machine with an [[Admin Code]] to re-Pair it by hand. Half-hourly costs 48 attempts a day and makes that self-healing.

## Consequences

A revoked Client still retries forever, which keeps PRD §5.3 intact: revoke is not remote uninstall, and the Client goes standalone rather than dormant. What changes is that it now *says so*. Sharing one ladder also meant sharing one presentation, so a rejected Client looked exactly like a Client with no wifi — indefinitely, with the explanation buried in a local text file. It now has its own state in the tray and the [[Flyout]], pointing at the re-Pairing that is the actual fix.

The cost is a second ladder and a second state to keep straight, and a `4001` arriving during a genuine outage will drop that Client onto the slow ladder for up to half an hour. That is the right trade: `4001` is a deliberate server-side act, not a symptom of a flaky link.
