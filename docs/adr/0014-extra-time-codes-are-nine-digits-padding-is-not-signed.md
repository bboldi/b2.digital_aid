# Extra Time Codes are always nine digits, and the padding is not part of what is signed

An [[Extra Time Code]] is six derived digits followed by the minutes. The minutes ran from 1 to 999, so a code was seven, eight or nine digits depending on how much time was being given: `4821025` for five minutes, `48210215` for fifteen. Codes are now always nine, with the minutes zero-padded — `482102005` and `482102015` — and they are written down in threes, `482-102-015`.

Grouping a number is what makes it survive being read down a phone to someone who will mistype it once, which is the situation this code was designed for. But grouping only helps if the groups are the same every time. A code that is sometimes `xxx-xxx-xxx` and sometimes `xxx-xxx-x` has a ragged tail, and a ragged tail defeats the point: the reader cannot tell a short code from a truncated one, and a wrong code no longer *looks* wrong. Padding to a fixed nine buys one shape.

**The padding is display and transport only. It is not in the derivation.** The HMAC input remains `"{minutes}:{step}"` with the plain integer — `15`, not `015`. This is the part a future reader is most likely to get wrong, because it looks like an inconsistency and is not. Padding the HMAC input would change every code that has ever been valid and would have to land on the server, the browser and every Client at the same instant. Padding only the written form changes nothing about what is signed.

That distinction is what made the change safe to ship at all, and the discovery that settled it: **a nine-digit code is already accepted by Clients running the current build.** `GrantCode.TryParse` accepts a length of seven to nine, requires ASCII digits, and calls `int.Parse` on the tail — and `int.Parse("015")` is `15`. So the padded form parses, verifies and redeems on a machine that has not been updated. The three implementations in `server/src/grant-code.js`, `server/public/family-code.js` and `client/Client.Core/GrantCode.cs` still have to move together, and the vectors in `server/test/grant-code.test.js` are what holds them to it — but nothing has to move *first*.

The separators are the opposite case, and the asymmetry decided how they are handled. `TryParse` requires every character to be a digit, so `482-102-015` is rejected outright by a Client that has not been updated. Dashes therefore appear wherever a code is *shown* — the admin UI, a [[Trusted Device]], the entry box on the Client as it is typed — and never in what the copy button puts on the clipboard. A code sent over a messaging app arrives as bare digits and pastes into any Client, updated or not.

## Consequences

`TryParse` gains separator tolerance — dashes, spaces, non-breaking spaces and dots are stripped before validation — so a hand-typed `482-102-015` works once that build has rolled out. Until then it does not, which is precisely why the clipboard carries plain digits.

The grouping is presentation and must never be persisted, compared, or sent over the wire. A code that arrives as bare digits is the same code.

Every recorded Extra Time Code string changes, including the vectors. The digits behind them do not: the same seed, minutes and step produce the same six digits as before. A test that fails after this change is comparing strings, not derivations.

The [[Admin Code]] is left alone — six digits, ungrouped, exactly as an authenticator app renders it, which is where a parent reads it from. The two codes are now told apart at a glance by shape rather than by counting: six ungrouped, or nine in three groups.

Nine digits is not more secure than eight. The six derived digits are unchanged and are the entire strength of the code; the tail is the minutes travelling in the clear, bound into the derivation so that editing them invalidates the code rather than minting time ([ADR-0006](./0006-grant-codes-are-derived-from-a-separate-grant-seed.md)).
