# A new Admin Code is provisional until someone proves it

Generating an [[Admin Code]] used to be one motion: make a secret, write it to the database, push it to every connected [[Client]], and show the QR once with "scan this now — it will not be shown again". An Admin who closed that tab without scanning had, in one click, given every PC in the house a secret nobody held. The app could no longer be stopped on any of them and no new PC could be paired, and nothing anywhere said so — the next sign of trouble was a parent standing at a [[Block Screen]] with no way through it.

A new secret is now **provisional**. It waits in `pending_totp_secret` while whatever is in force stays in force, and it is promoted only when someone types back a code derived from it. The page shows the QR and the secret but deliberately never a current code, so there is nothing on screen to copy: producing six correct digits is only possible from something outside this server, which is precisely the claim being tested. Clients are told after the promotion and never before.

The reason the claim is worth testing is that the Admin Code is the one secret that must exist somewhere else. Clients verify it offline, so they are fine either way; the parent is the half that cannot, and the night it matters — a PC that will not let go — is the same night this server is most likely to be unreachable. A secret that only ever lived in this database is not a secret anyone has.

Failing now costs nothing, which is the other half of the design. A phone whose clock has drifted past the ±1 step tolerance produces codes this server rejects, and under the old flow that left the household locked out of itself; under this one the Admin backs out and nothing ever happened. First run offers a fresh pair instead, since a bad scan and the wrong entry in an authenticator app are the two failures that actually occur and neither is worth stranding an install over.

**Skipping is allowed.** A checkbox behind a disclosure — one click of friction, enough to separate deliberate from impatient — activates the secret unproven, against an acknowledgement that names the consequence rather than warning vaguely about problems later. Test servers exist, and so do people who have weighed it up; an escape hatch that requires shell access is not one for either. What makes it safe is that `admin_code_confirmed` remembers, so the Codes page carries a standing note and a box to prove it later. A skip stays skipped without nagging, and an oversight stays visible until somebody fixes it.

## Consequences

First-run setup can now be left half-done: an admin row exists, no Admin Code is in force, and one is waiting. That state is deliberately loud. `POST /api/pair` answers `503`, so no PC can attach; every admin page redirects back to the confirmation screen, which is how a closed tab recovers; and `/family-code/current` answers `503` rather than throwing, because it is guarded by `isLoggedIn` rather than the redirect and a cached Codes page in a service worker will keep polling it. A server nobody can pair to is a much louder failure than a server holding a secret nobody has, and it is the failure that gets fixed the same afternoon.

The provisional secret is re-shown on return, which bends PRD §5.1's "shown exactly once". Read as once per *activated* secret it still holds: a pending secret has never protected anything, and refusing to show it again would leave the only exit as regenerating — the fumbling this exists to prevent.

`totp_secret` is `''` rather than `NULL` while nothing is in force, because the column is `NOT NULL` in a schema that predates this and rebuilding the table to express it more prettily is not worth the migration.

Nothing here defends against an Admin who confirms on a phone and then loses the phone. That is what regeneration is for, and it is why the admin password and the Admin Code are deliberately different keys.
