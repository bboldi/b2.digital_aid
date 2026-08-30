# Grant Codes are derived from a separate Grant Seed, not from the Family Code

A Grant Code used to be `[(FamilyCode + minutes) mod 1000000][minutes]`, which is invertible: subtract the trailing minutes and you have the current Family Code, which is also the key that exits the app. Every "here's 15 more minutes, type `12347115`" was therefore also handing over that evening's exit key, and a kid who noticed the pattern once could use it every time. A Grant Code is now six digits of `HMAC(Grant Seed, minutes ‖ 60-second time step)` with the minutes still appended in the clear, verified offline by each Client against its own copy of the seed, ±1 step. The [[Grant Seed]] is a second household secret generated, distributed and rotated alongside the Family Code secret, and never displayed or typed.

Three properties follow. Collecting Grant Codes yields nothing about the Family Code, so granting time is no longer a slow leak of the exit key. Editing the trailing minutes invalidates the code rather than minting time, because the minutes are inside the HMAC — the old scheme only made that awkward, this makes it fail. And the derivation is ours rather than RFC 6238's, so the step is a free parameter; 60 seconds with a ±1 window gives about two minutes of life, roughly triple the old window, which is what reading eight digits down a phone to someone who will mistype them actually needs.

## Considered options

- **Obfuscate the existing scheme with a server seed.** Mix a seed into the addition so the recovery arithmetic is non-obvious. Rejected: it costs the same authenticator-app compatibility as a real fix while still leaving the Family Code recoverable by anyone who reads the source or thinks about it hard enough. Paying a real price for obscurity is the worst of both.
- **Per-Client seeds instead of one household seed.** Would stop a code read out for one machine being redeemed on another. Rejected: a [[Trusted Device]] would have to hold and sync every Client's seed, and the Admin would have to pick a machine before generating a code — offline, from a phone, at bedtime. The replay it prevents is one the system already declines to defend, since no-reuse has always been scoped per-Client.
- **Accept old-format codes when no seed is stored.** Rejected: the fallback is exactly the weakness being removed, and it fails *open* — a kid who prevents the seed arriving gets the recoverable scheme back. A Client without a seed refuses Grant Codes until it reconnects, which is visible and fixable.

## Consequences

An authenticator app can no longer produce a Grant Code; extra time now requires the admin UI or a Trusted Device. With the server down and no trusted browser to hand, a phone can still exit a Client — pure TOTP, unchanged — but cannot grant it fifteen minutes. Accepted deliberately: the offline path that matters most is already the PWA's, and exit is the emergency lever, not grant.

Because the code is a pure function of (seed, minutes, step), granting the same number of minutes twice inside one step produces identical digits and the second is refused as already-redeemed. The 60-second step makes that a near-impossibility rather than a bedtime annoyance, and asking for 16 minutes instead of 15 is a complete escape hatch.

This retires the trade-off recorded in the Consequences of ADR-0004. A kid who kept "a Family Code read aloud for a Grant" no longer exists as a threat, because Family Codes are not read aloud for Grants. What remains is a kid who was told a Family Code outright — rarer, and still bounded by midnight release and the `exit-via-code` Event.
