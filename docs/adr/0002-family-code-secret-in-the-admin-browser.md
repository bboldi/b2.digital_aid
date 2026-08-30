# The Family Code secret may live in an opted-in Admin browser

The admin UI is a PWA, and the moment it is most needed is the moment the home server is unreachable: the kid is blocked, and the parent wants to hand over a Grant Code. Computing that code needs the Family Code secret, which until now lived only on the server and in the parent's authenticator app — so we let the Admin explicitly opt one browser in, re-entering the admin password, after which the secret is held in that browser's IndexedDB and all Family Code and Grant Code arithmetic happens client-side, online and offline alike.

## Considered options

- **Never store the secret.** Keeps PRD §5.1 ("the secret is shown exactly once") literally true and leaves the phone's authenticator app as the only copy. But offline it can offer nothing beyond the "add the minutes yourself" arithmetic card — mental arithmetic mod 1000000, at the exact moment the parent is under pressure.
- **Store it for every browser that logs in.** Simplest to build, and makes offline the default. Rejected: a shared or borrowed device silently becomes a permanent holder of the household's root credential, with no moment where the Admin was asked.
- **Opt-in per browser, password-gated (chosen).** The Admin performs a deliberate act on a device they choose, and re-proves they are the Admin rather than someone holding an unlocked phone with a live session.

## Consequences

The secret gains copies we cannot enumerate or remotely wipe, and any XSS in the admin UI now exfiltrates it rather than merely riding the session. Two things bound the damage. The parent's authenticator app is already on the same phone for most opted-in devices, so the usual case adds no new trust boundary. And regeneration remains the recovery path it always was: a new secret makes every stored copy inert, since Clients follow the server's secret, not the browser's.

Because the code path is shared rather than forked, an opted-in browser computes codes locally even while online — there is no separate "offline mode" that only runs during an outage and is therefore only tested during one. Browsers that have not opted in keep polling the server and simply lose the tab when it is unreachable.
