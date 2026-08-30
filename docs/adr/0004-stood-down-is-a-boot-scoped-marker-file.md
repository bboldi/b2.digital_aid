# Stood Down is a boot-scoped marker file, not a disabled Scheduled Task

Exiting with a Family Code used to buy a minute: the Scheduled Task's one-minute repetition trigger restarted the app immediately, so "exit protection" was not an exit. Making it stick cannot be done by disabling the task — the task is created by an admin precisely so the kid's standard account cannot touch it, and the app itself runs unelevated. Instead the app writes `state/exited.marker` stamped with the current boot instant (`DateTimeOffset.Now - Environment.TickCount64`) and refuses to start when a scheduler launch finds a marker from the *same* boot. A reboot invalidates the stamp for free.

Two consequences follow from the mechanism. The task action regains a `--scheduled` argument (removed earlier) so a bare double-click is distinguishable from a watchdog launch and can clear the marker — otherwise "restart it manually" would be impossible. And [[Stood Down]] becomes the only override in the system that is not remotely reversible, because no process survives to receive the reversal.

## Considered options

- **Until the next reboot.** What was originally asked for. Rejected: its failure mode is silent and unbounded — a parent stands the app down to install something on a Tuesday, forgets, and nobody reboots for three weeks.
- **Until local midnight, or the next reboot, whichever comes first (chosen).** Reuses the rule [[Lock]] already follows for the same reason, so no unattended override outlives the day it was made. The cost is a parent who stands it down at 22:00 getting the app back at midnight; that is a visible annoyance rather than a silent hole.

## Consequences

This interacts with the decision to accept a bare Family Code as the Block Screen's exit key. Separately each is cheap; together they mean a kid who has kept a Family Code read aloud for a Grant can clear the Block Screen at 21:00 and hold the machine for the rest of the evening, unlogged. Midnight release is what bounds that to one evening. The real countermeasure remains the one this project has always relied on: the `exit-via-code` Event and the Ping gap make it visible.

_Superseded in part by ADR-0006: Grant Codes no longer contain a recoverable Family Code, so "a Family Code read aloud for a Grant" is no longer a way to acquire the exit key._
