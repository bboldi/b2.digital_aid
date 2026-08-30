# Alerts are derived from Ping transitions, not from Events

Three of the four [[Alert]]s describe things happening on a [[Client]]: it came on, its [[Time Left]] ran out, the kid stepped away. The obvious place to get those is the Event log — it is the system's record of discrete occurrences, it already carries `unclean-exit` and `os-shutdown`, and adding `startup` and `screen-locked` to `PROTOCOL.md §7.2` would be a small change. We did not do that. Alerts are computed server-side by watching the status field of consecutive [[Ping]]s, and no new Event type exists.

The reason is what an Event is for. An Event is a claim about the past, and it is built to survive: `EventQueue` is an append-only file with a two-phase take/commit, deliberately re-delivering after a crash rather than losing a row, and the server dedupes on `seq` to make that safe ([ADR-0001](./0001-event-sequence-numbers-not-acks.md)). That durability is exactly right for an audit trail and exactly wrong for a phone buzzing in a pocket. An Alert is a claim about *now*. A `startup` Event generated at 06:40 while the link was down would be delivered when the link returned at 09:00, and would push "the PC came on" about a morning that was already over. The queue would be working perfectly and the Alert would still be a lie.

A Ping cannot fail that way, because a Ping is never queued. It is sent or it is lost, and a lost one leaves a gap that means offline or killed — which the glossary already treats as information rather than an error. So a transition between two Pings is inherently about the minute it was observed in. The worst a Ping-derived Alert can be is absent; it cannot be stale.

It also avoids a second record of a fact the log already holds. The [[Ping]] log is described as the parent's audit trail of when the PC was on. Adding `startup` Events would put the same fact in two places, in two formats, with two ways of disagreeing.

The last reason is not architectural but it is real: this way the whole feature ships in `server/`. No protocol generation, no change to `Client.Core`, no new Windows build to get onto every machine before any of it works.

## Consequences

Alerts see the world at one-minute resolution and only in transitions, so anything that begins and ends inside a single minute is invisible. A kid who locks and unlocks in forty seconds produces no Alert. This is a feature rather than a limit — the damping below wants far more than a minute anyway.

**A gap in Pings does not prove the PC was off.** The client keeps enforcing while offline; a dropped network, a restarted server, or a reloaded reverse proxy all produce the same silence as a powered-down machine. A "came on" Alert therefore fires on a gap of **10 minutes** and is suppressed in two cases the server can recognise: when its own start time falls inside the gap, and when more than one Client resumes within the same minute — two machines returning together is a network event, not two kids. What survives is a genuine outage longer than ten minutes that ends while a PC is in use, which fires one false "came on" per Client. Accepted, and deliberately not chased with `unclean-exit` and `os-shutdown` Events: those would prove the machine really stopped, and would arrive whenever the link came back, which is the delayed-and-wrong-about-now problem this decision exists to avoid.

Sleep is not a source of that ambiguity. `PROTOCOL.md §7.1` folds asleep, locked and logged out together into `locked`, so a sleeping PC keeps pinging and never goes quiet.

"Stepped away" is held for **10 minutes** before it fires. Locking is behaviour this system actively encourages — the [[Flyout]] offers a button for it, because pausing the clock is the kid's own escape from spending time they did not mean to spend. Alerting on every lock would buzz two phones through lunch, a bathroom trip and answering the door, and would punish the exact habit the app is trying to teach. Ten minutes matches the ping-gap number so there is one figure to remember rather than two.

"Time is up" fires only on `reason: exhausted`, never on the other two things that produce `status: blocked`. [[Downtime]] arrives at the same minute every night by a rule the [[Admin]] wrote, and an Alert for it is a daily buzz confirming that configuration still works — the fastest way to teach someone to swipe this channel away. An [[Lock]] or [[End Today]] was pressed by a human who already knows. `exhausted` is the only one nobody scheduled and nobody triggered, and the only one where an [[Extra Time Code]] might be wanted in the next minute. The cost is that **End Today** produces no confirming Alert.

The [[Request]] Alert is the exception to all of this and is driven by the write, not by a Ping — at both ends. It is sent when the ask is recorded, and sent again under the same notification tag when a verdict lands, so the operating system replaces the question with "Answered — 20 minutes" on every [[Alert Device]] rather than leaving a resolved ask on the other parent's lock screen. It cannot say who answered: there is exactly one [[Admin]], so the server does not know.

Reversing this means adding Event types, bumping the protocol generation, and shipping a client build — the ordinary cost of a protocol change, and the reason it is worth being sure now.
