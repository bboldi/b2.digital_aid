# Request verdicts outlive the socket

Every server→client command in this system is live-only: a Lock, an Adjustment or a message aimed at an offline Client is dropped, and the admin UI disables the button and says so ([[Client]] §6.4). A [[Request]] verdict is the first exception. When the Admin approves 20 minutes, the row is stamped and the message is sent if the socket is up; if it is not, the verdict is held and delivered immediately after `hello` on the next connect.

The asymmetry is deliberate and small. A Lock is a *standing intent* the Admin can simply re-issue when the PC reappears — nothing is lost by dropping it. A verdict is the *answer to a question somebody asked*, and dropping it silently produces the one outcome this feature exists to prevent: a kid who asked, a parent who said yes, and a PC that never heard. The kid learns that asking does nothing, which is worse than never having offered the button.

## Considered options

- **Live-only, like everything else.** Simplest, and consistent. Rejected because the failure it produces is silent on both sides: the Admin sees "approved", the kid sees nothing, and neither has a reason to suspect the other.
- **Queue it like an Event, delivered whenever.** Rejected for the opposite reason. A [[Grant]] for 20 minutes landing at 07:40 the next morning, because that is when the PC next booted, is not the thing the parent approved. Extra time is only extra time in the moment it was asked for.
- **Held, but perishable (chosen).** A verdict stays deliverable for 30 minutes from the decision, and never past local midnight. Past that it lapses.

## Consequences

Lapsing must be visible to the parent, or this trades a silent drop for a silent expiry. Lapsed Requests therefore stay in the table and appear in the Requests page history distinguishing the two ways they die — *nobody answered in time* and *never reached the PC* — so "I approved 30 minutes and she says she never got them" is answerable on the screen rather than in a log file.

The kid is told nothing when a verdict lapses, on purpose. From their side nothing happened: they asked, nobody answered, and the ask expired — which is the same experience as an unanswered Request and needs no extra vocabulary.

Delivery is confirmed by the send, not by the Client. There is no acknowledgement message, in keeping with §8 — a socket that accepted the frame and then died loses a verdict, and that is accepted rather than fixed with a receipt protocol. The Client applies an approval exactly as it applies a positive [[Adjustment]], so a duplicate delivery would double the minutes; the `delivered_at` stamp is what prevents a second attempt.
