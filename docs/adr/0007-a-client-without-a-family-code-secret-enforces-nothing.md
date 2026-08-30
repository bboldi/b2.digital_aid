# A Client without a Family Code secret enforces nothing

A Client that lost its state file kept running: `Start()` fell through to the tick regardless of pairing, so the engine enforced `Settings.Default` — 120 minutes and a 21:00 Downtime nobody had configured — and raised a Block Screen. Exit was impossible, because verifying the Family Code needs the secret that went missing with everything else, and the Scheduled Task restarted the process every minute. The result was an unkillable app enforcing invented limits, removable only by uninstalling. A Client holding no Family Code secret is now [[Unconfigured]]: it counts nothing, blocks nothing, and exits on request without a code, standing itself down so the watchdog leaves it alone.

Enforcement authority in this system derives from the shared secret. Without it the app is guessing at policy and has nobody to ask for permission to stop, so the honest thing is to do neither. The alternative — keep enforcing and add an escape hatch — is worse at both ends: a hatch weak enough for a parent to use is one a kid can use, and gating it on elevation only helps someone who could uninstall the app anyway.

## Consequences

Deleting `state.json` is now a clean bypass, and `ProgramData` is app-writable by design so that self-update can replace the exe. This is accepted under *visibility over enforcement*, and it is among the loudest circumventions available: that Client stops Pinging permanently rather than for an evening, and re-Pairing allocates a fresh Client, leaving the abandoned one visible in the admin UI going nowhere. Compared with what it replaces — a zombie enforcing fictional limits that punishes the parent as much as the kid — it fails in the direction that gets noticed and fixed.

State loss is recorded in the client log only, not as an Event. An Event could not be delivered until the Client re-pairs, and it re-pairs as a *different* Client, so the record would land on the wrong timeline. The permanent Ping gap is the real evidence.

Separately, the crash that exposed this was its own bug: state was written to a temp file and renamed without ever being flushed, so a force-off left the directory entry pointing at unwritten blocks. That is fixed, and this decision is the defence for the cases a flush cannot cover — disk corruption, a fresh install, and deliberate deletion.
