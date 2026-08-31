# Digital Aid

A self-hosted digital wellbeing system for kids' Windows PCs: a Node server (single admin) holds settings and usage history; a client app on each PC enforces time limits, working offline when needed.

Guiding principle: **visibility over enforcement**. The app helps kids learn healthy usage and shows the parent what happened; it is not tamper-proof and does not try to be. Circumvention should be *visible in the log*, not impossible. Transparency cuts both ways: no covert surveillance of the kid — the system records machine state (on/off, blocked, usage), never content or screenshots.

## Language

**Client**:
One Windows machine paired with the server. All limits and usage tracking attach to the machine, not to a person. One allowance per machine — shared PCs share it, a kid with two machines gets two.
_Avoid_: device, kid, child, user (for the machine)

**Usage Time**:
Time during which a Windows session is logged in and unlocked on a Client. The clock pauses on lock, logout, and sleep; idle time with the screen unlocked still counts.

That pause is the kid's own escape from spending time they do not mean to spend — locking the screen costs them nothing, and the [[Flyout]] offers it as a button rather than leaving it to whoever knows the keyboard shortcut. A [[Grant]] is the exception and keeps running regardless: it is a window of wall-clock minutes, and pausing one would let extra time be banked across the start of [[Downtime]], which a Grant overrides.
_Avoid_: screen time, active time

**Allowance**:
The Usage Time budget for one calendar date on a Client, in the Client's local time. The date picks the rate: weekday allowance Mon–Fri, weekend allowance Sat–Sun. Resets at local midnight.
_Avoid_: quota, limit (alone)

**Downtime**:
A daily window during which a Client is blocked outright, regardless of remaining Allowance. Downtime beats Allowance; only an active Grant beats Downtime.

**Admin Code**:
The 6-digit time-based (TOTP) code from the parent's authenticator app. Used to pair a Client, to authorise re-Pairing, and to exit the client app — the three moments that need proof of parental intent in person. Not used to grant time; that is the [[Extra Time Code]]'s job and it uses a different key.

Its secret is one of the household's two, alongside the [[Grant Seed]]; both are generated together, held by every Client and [[Trusted Device]] so codes verify offline, and regenerated together by the Admin. Offline Clients honour the old pair until their next server contact.

A newly generated secret does not take effect until someone proves they can produce a code from it — typed back from an authenticator app, which is the only place the digits can come from. Until then the old pair stays in force and no Client is told anything. This is the one secret that has to exist somewhere other than the server: Clients check it offline, the Admin cannot, and the night it is needed is the night the server is least likely to answer. The proof can be waived deliberately, and the Admin is reminded until it is given.
_Avoid_: 2FA, OTP (it authenticates parental intent, not a login); Family Code (retired — it named the wrong audience: only the Admin should hold it)

**Grant Seed**:
The household's second secret, and the key behind every [[Extra Time Code]]. Unlike the [[Admin Code]] secret it is never seen, read aloud, or typed — it exists so that an Extra Time Code cannot be worked backwards into an Admin Code. Held wherever Extra Time Codes are made or checked: every Client, and every [[Trusted Device]]. No authenticator app can hold it, so no phone can produce an Extra Time Code.
_Avoid_: grant key, grant secret (pick one term)

**Foreground App**:
The product name of the application in the foreground (e.g. "Minecraft"), sampled with each Ping — never window titles, URLs, or background process lists. Feeds the per-app usage statistics shown in the Client Page and Usage Report: a shared statistic, not surveillance.

It also shows on the parent's side as what the Client is in *right now*, on the Clients grid and the Client Page. That readout is only ever the last Ping's value while the Client is online: the kid is looking at their own foreground already, so the parent seeing it too is a difference of timeliness, not of knowledge. There is no Foreground App while a Client is locked, blocked, or offline — the Client sends none, and the parent's side shows none rather than the last one it saw. A stale app name would be a claim about now that nothing supports.
_Avoid_: app title, process list; current app (it is the same term whether read live or in aggregate)

**Grant**:
Extra Usage Time for a Client: a window of N minutes (max 999) starting at redemption, during which the Client stays usable — overriding both an exhausted Allowance and Downtime (live parental intent beats standing policy). Delivered by typing an **Extra Time Code** on the Client, or as a positive Adjustment from the server (identical effect). Every redemption is logged with the minutes actually claimed (visibility over enforcement). A code cannot be redeemed twice on the same Client.
_Avoid_: bonus time, extension

**Extra Time Code**:
The input that redeems a Grant: six digits derived from the [[Grant Seed]], the minutes, and the current minute, followed by those minutes in plain sight, zero-padded to three — e.g. `482102015` is 15 minutes. Always nine digits, so a code has one shape rather than three, and a wrong one looks wrong. Written down in threes (`482-102-015`) because that is how a number gets read down a phone without losing the place; the grouping is a way of showing it and never part of it, so a code that arrives as bare digits is the same code. The Client checks it offline against its own copy of the seed, ignoring whatever spacing it was typed or pasted with.

Nothing about the [[Admin Code]] is present in it, so no amount of collecting Extra Time Codes yields the key that exits the app. Editing the trailing minutes doesn't mint time either — it invalidates the code, because the minutes are part of what the six digits are derived from. A code lives about two minutes, long enough to read down a phone and mistype once. Made only by the admin UI or a [[Trusted Device]]; a phone with an authenticator app can exit a Client but cannot grant it time.
_Avoid_: grant code (retired — jargon; nobody outside the code said it)

**Time Coupon**:
A gift of time made ahead of the moment: minted by the Admin, handed to the kid, and spent whenever the kid chooses. Written as six letters followed by the minutes in three digits — nine glyphs in threes, like an [[Extra Time Code]], but the letters say at a glance which kind it is. The letters come from a fixed alphabet with no vowels and no lookalikes, so a coupon never spells a word and never confuses `I` with `1`; entry is case-insensitive, display is uppercase.

Redeeming one adds its minutes to today's [[Allowance]] — they pause on lock, [[Downtime]] still beats them, and whatever is left dies at local midnight. A standing promise does not carry live parental intent, which is why a coupon tops up Allowance instead of becoming a [[Grant]]: only a Grant beats Downtime. Redemption during Downtime is refused and the coupon stays unspent.

A Time Coupon is checked by the server, not against a seed — it is the one code that needs the server reachable, which a standing promise can afford where a bedtime emergency cannot. Each coupon is single-use — good on one named [[Client]] or on any, but spent by whichever redeems it first — and can be revoked before it is spent. It may carry an expiry date: redeemable through that date inclusive, or indefinitely without one. Expiry bounds when it can be *redeemed*, not how long the minutes last.
_Avoid_: voucher; coupon code (the coupon is the thing, not its printing); pre-defined time code (retired working name)

**Request**:
The kid asking a parent for more time, from the tray or the [[Block Screen]] — the only channel in this system that runs kid→parent. Carries one number, the minutes asked for, and nothing else: no reason, no message. That keeps the promise "never content" intact, and keeps "ask for more time" from becoming "justify yourself". The number is advisory — the Admin picks the real minutes when approving.

A Request is a live ask, not a standing state, so it expires 60 minutes after it is made (or at local midnight, whichever comes first) — "can I finish this match?" answered four hours later is a different question. One open Request per [[Client]]; asking again while one is open just re-shows "waiting for a reply", and a decline starts a 15-minute cooldown. An approval becomes a [[Grant]] on the Client, a decline becomes a message the kid must dismiss.

An answered Request stops being a live ask but does not stop being a record: it is kept, and kept forever. A declined one is the evidence behind its own cooldown, and the run of them is how a parent notices "she asks every night at nine" — a thing no single Request shows. That is why the record is read in date order rather than a day at a time: the repetition is the finding, and a one-day window hides it. A Request nobody answered is kept on the same footing as one that was refused; that it lapsed is itself the fact.
_Avoid_: appeal, petition, ask (as a noun)

**Ping**:
A once-a-minute report from a Client to the server: alive + current status (e.g. blocked or not). Stored server-side with the server's timestamp — this ping log is the parent's audit trail of when the PC was on, independent of the Client's clock. Gaps mean offline or killed, and that is information, not an error — which is why a Ping is never skipped just because nothing changed. Pings are kept at full minute resolution for 30 days, then folded into a [[Daily Summary]].

**Daily Summary**:
What remains of a day once its Pings pass the 30-day horizon: one row per Client per date holding used minutes, blocked minutes, longest session, and the per-app breakdown. It answers "how much was he on last March", which is the question that outlives minute-level detail. Kept forever. Today's figures are never read from here — they come from live Pings, so the Client Page doesn't depend on the nightly rollup having run.
_Avoid_: rollup, archive (those name the mechanism, not the thing)

**Event**:
A discrete, timestamped occurrence on a Client, logged locally and synced to the server (queued while offline): Grant redeemed, Adjustment applied, update installed, clock jump, message shown, exit-via-code, remote kill, OS shutdown, unclean exit, server unreachable. An unclean exit (kill/crash/power loss — indistinguishable) is inferred at next startup from a still-present "running" marker, since a hard-killed process cannot log its own end. Events color the timeline alongside Pings.

**Install Kit**:
The zip a parent downloads to put the client app on a new PC: the latest client build plus the install and uninstall scripts, flat, in one archive. Downloadable without logging in — the parent is usually standing at the kid's machine, not at their own. It carries no history: one kit, always the latest build, because an older one would update itself within a minute of [[Pairing]] anyway.
_Avoid_: installer (that is the script inside it), client download (a [[Client]] is a machine, not a file)

**Pairing**:
Connecting a client app to the server by entering the server URL and a current Admin Code. A machine already known to the server is recognised, and Pairing offers to reconnect to that Client rather than create a second one — history, settings and name survive a lost state file that way. The offer is never taken silently, and being recognised proves nothing on its own: the Admin Code is what authorises the reconnection. Declining creates a new Client; stale ones are deleted by the Admin, keeping their history until then.

Re-Pairing an already-paired Client costs an Admin Code up front. It is the one action that hands over everything at once — a Client pointed at a server the kid controls has whatever Allowance and Downtime that server says, while the real server sees only a machine that went quiet.

**Unconfigured**:
A Client holding no [[Admin Code]] secret — never paired, or its stored state lost to disk corruption or deletion. It enforces nothing, blocks nothing, and lets anyone exit it without a code: authority in this system comes from the shared secret, and a Client that has none is guessing. Deleting the state file is therefore a way out, and a loud one — that Client stops Pinging until someone re-Pairs it, and the gap stays in its timeline afterwards, because re-Pairing reconnects to the same Client rather than starting a clean one.
_Avoid_: unpaired (that is one cause of it, not the state)

**Client Page**:
The per-Client view in the admin UI: timeline of Pings colored by Events, current status and version, remaining time today, settings, and message/Adjustment controls.
_Avoid_: dashboard (ambiguous)

**Usage Report**:
A read-only view of one Client's Usage Time over a chosen server-calendar reporting period, showing the same daily totals, blocked time, Allowance, and Foreground App breakdown whether opened by the Admin or by someone at that Client. Its daily average covers every calendar day in the period, including days with no recorded usage; on a shared Client it describes the machine's combined usage, not one person's activity.
_Avoid_: client report (a Client is the machine, not the audience), user report

**Report Link**:
A temporary link issued at a paired Client that lets anyone holding it open that Client's Usage Report for one fixed reporting period. It may be reopened for 30 minutes after issue, alongside any other Report Links; it grants no other access and never replaces an Admin session. Revoking, re-Pairing, or deleting the Client invalidates its Report Links, while pausing enforcement does not.
_Avoid_: report hash, public report

**Flyout**:
The kid-facing view on the Client itself (from the tray icon): remaining time today and next Downtime. The kid sees their own data — transparency cuts both ways.
_Avoid_: dashboard (ambiguous)

**Client Token**:
The permanent per-Client credential issued at Pairing — stored on the machine, stored hashed on the server. Revoking it cuts the Client off from the server; the client app then keeps enforcing its last-known settings standalone (revoke ≠ remote uninstall).

**Adjustment**:
An Admin-initiated change to a Client's remaining time for today, positive or negative, delivered while the Client is online. A positive Adjustment behaves like a Grant; a negative one that empties remaining time blocks the Client after a brief warning.

**Lock**:
An Admin-triggered immediate block ("stop now"). Beats everything, including an active Grant — it's the strongest override. Stays until the Admin unlocks, or auto-releases at local midnight so a forgotten Lock never eats the next day. A live command; a toggle (Lock ⇄ Unlock).

**Stood Down**:
The state a Client enters when someone exits the app with a [[Admin Code]]: the app is gone *and stays gone*, instead of being restarted within the minute by the Windows task that normally watches it. Auto-releases at local midnight, or at the next reboot, whichever comes first — no unattended override in this system outlives the day it was made. Unlike [[Lock]] or the Disable pause, it cannot be reversed from the server: there is no process left to receive the command. The Event log records who stood it down and when; the gap in [[Ping]]s records what it cost.
_Avoid_: killed, uninstalled, stopped (it is temporary and self-releasing)

**End Today**:
An Admin action that drains the rest of today's Time Left at once — exhausts the Allowance and clears any active Grant, so the Client blocks now. Not a toggle and not permanent: a fresh Grant can still give time back, and tomorrow's Allowance is untouched. Distinct from [[Lock]], which is a held state.

**Block Screen Background**:
An image shown behind the [[Block Screen]], in two variants: one for a Client that has run out of time, one for [[Downtime]]. The variants exist because "you have used your hour" at four in the afternoon and "it is night" at half past nine are different messages, and the picture is the only part of that screen that says so without words. An Admin-triggered [[Lock]] and [[End Today]] both use the out-of-time variant.

Set once for the household and optionally overridden per [[Client]], each variant resolving on its own — a Client can take the household's out-of-time picture and its own night-time one. With neither set, the Block Screen is plain, and it is plain again whenever an image is missing, unreadable, or not yet downloaded: a kid looking at a cover is not the audience for an Admin's misconfiguration.

Held on the Client's own disk rather than fetched when needed, because the Block Screen appears at exactly the moments the server is most likely to be unreachable.
_Avoid_: wallpaper, lock screen image (Lock is a different thing entirely)

**Block Screen**:
The fullscreen, topmost, all-monitors cover shown when Allowance is exhausted or during Downtime. While present, it is meant to remain the visible and interactive surface over ordinary applications in the Client's Windows session; elevated applications, exclusive-fullscreen games, and Windows security surfaces remain outside that guarantee.

Preceded by warnings (~15 and ~5 minutes) rather than appearing unannounced. Those warnings name which of the two is coming — running out of time and reaching Downtime are different messages, the same distinction the [[Block Screen Background]] variants draw. "Downtime" is the word used to the kid as well; there is no softer synonym for it.

Because it covers the taskbar, it is the *only* reachable surface while blocked, so it carries every way out: Grant input, **Shut down** (no code — a kid can hold the power button anyway, and a clean shutdown logs better than a hard one), and **Exit application** (a bare [[Admin Code]], same as the tray).

Those two ways out are deliberately not the same key. Extra time is asked for often and read out over the phone; exiting is rare and deliberate. Because a [[Extra Time Code]] reveals nothing about the Admin Code, granting time freely never spends the ability to exit. A kid who has been told an Admin Code outright can still leave the block screen any night — that is what the Event log is for.

**Server Key**:
A random secret generated at first server start, used only to sign Admin sessions. Rotating it logs the Admin out and nothing else.
_Avoid_: server hash

**Time Left**:
What the kid can use *right now*, not the raw budget. If a Grant is running, it's the Grant's remaining minutes; during Downtime with no Grant, there is no number — it's "quiet until HH:MM"; otherwise it's the remaining Allowance. Dormant Allowance that Downtime makes unreachable is never counted as Time Left. Shown identically on the Flyout and the server.
_Avoid_: remaining minutes (ambiguous — budget vs usable)

**Admin**:
The single parent account on the server. There is exactly one; it owns all clients.
_Avoid_: user (ambiguous with the kid)

**Remember Me**:
An Admin choice at login to keep the session alive across browser restarts (sliding, ~30 days) instead of only for the browsing session. It remembers the *session*, not the username — an unchecked login is still a short-lived one. Independent of [[Trusted Device]]: remembering is about staying logged in, trusting is about holding the [[Admin Code]] secret. A device can be either, both, or neither.
_Avoid_: stay signed in, keep me logged in (pick one term)

**Trusted Device**:
A browser the Admin has deliberately given a copy of both household secrets to — the [[Admin Code]] secret and the [[Grant Seed]] — by re-entering the admin password. It computes Admin Codes and Extra Time Codes itself, so those keep working when the server is unreachable — the case that matters most, since a blocked Client and a dead server arrive together. Trust is per-browser and cannot be revoked remotely; regenerating the secret is what makes stored copies inert.
_Avoid_: trusted browser, remembered device (that is [[Remember Me]])

**Alert**:
A push message sent to every [[Alert Device]] the moment something happens that a parent would want to know about now: a [[Client]] came on, its [[Time Left]] ran out, the kid stepped away for a while, a [[Request]] was made, or a [[Time Coupon]] or [[Extra Time Code]] was redeemed. It reaches a phone in a pocket, which is what separates it from the count in the nav bar — that one only exists while somebody already has the page open, and is therefore no use for any of them.

An Alert carries a fact and a destination, never a control: there are no Approve or Decline buttons on a lock screen. Tapping it opens the app at the page where the thing can be dealt with — a Request opens the Requests page, since the buzz says only that *someone* asked; the three status Alerts open that Client's page. Everything is then decided in the app, with the whole picture visible, exactly as it was before Alerts existed. Nothing about the system's behaviour depends on an Alert arriving.

Which of the four are sent is the Admin's choice, made once for the household rather than per [[Client]] or per device — every Alert Device gets everything that is enabled. Since there is exactly one [[Admin]], an Alert can never say *who* dealt with something, only that it was dealt with.
_Avoid_: notification (that is the operating system's word for the thing an Alert becomes), alarm, push

**Alert Device**:
A browser holding a push subscription — one the Admin granted notification permission to, on a phone or a desktop. Per-browser rather than per-person: two parents each install the app and each becomes an Alert Device, and one person's phone and laptop are two.

Independent of [[Trusted Device]] and of [[Remember Me]], the system's other two per-browser properties, and a browser can be any combination of the three. They answer different questions: trusting is about holding secrets, remembering is about staying logged in, and this one is only about being told things. A work laptop worth alerting is not necessarily one worth handing the [[Admin Code]] secret to.

Like trust, it cannot be revoked from the server — but unlike trust it expires on its own: uninstalling the app or clearing the browser kills the subscription silently, and the household learns of it only when a send is refused.
_Avoid_: subscriber, push device, notification device

## Example dialogue

> **Dev:** The laptop hit its Allowance at 20:40, but the Ping log shows it active until 21:05 — bug?
> **Parent:** No — I made a 25-minute Extra Time Code on my phone's browser and read it out, so a 25-minute Grant ran from 20:40. It even carried them past Downtime at 21:00; a Grant beats Downtime, Downtime only beats Allowance.
> **Dev:** Your phone's browser, not the authenticator app?
> **Parent:** It has to be — an Extra Time Code comes off the Grant Seed, and only the server and my trusted browsers hold that. The authenticator only makes Admin Codes now, which is exit and pairing. Fine trade: they've had a dozen Extra Time Codes off me this month and not one of them gets them out of the block screen.
> **Dev:** And the gap after 21:05 with an unclean-exit Event at next startup?
> **Parent:** That's the interesting part — either a crash or someone ended the process. Not the app's job to prevent it, just to make sure I see it. Same reason the Foreground App chart in their Flyout matches what I see on the Client Page: they know exactly what's recorded about them, and it's never content.

## Hungarian terms

The UI ships in English and Hungarian, and a translation done string by string re-runs every drift this
glossary exists to prevent — in a second language, where nobody is checking. So each canonical term has
exactly one Hungarian equivalent, fixed here and used everywhere.

| Canonical | Hungarian |
|---|---|
| Allowance | napi keret |
| Usage Time | használati idő |
| Time Left | hátralévő idő |
| Downtime | pihenőidő |
| Grant | extra idő |
| Extra Time Code | extra idő kód |
| Time Coupon | időkupon |
| Admin Code | adminkód |
| Block Screen | zárolási képernyő |
| Client | gép |
| Flyout | gyorsnézet |
| Request | kérés |
| Adjustment | módosítás |
| Pairing | párosítás |
| Lock | zárolás |
| End Today | mai nap lezárása |
| Alert | értesítés |
| Alert Device | értesítési eszköz |
| Install Kit | telepítőcsomag |
| Usage Report | használati jelentés |

Only terms that reach a screen appear here. The [[Grant Seed]] is deliberately absent: it is never shown
to anyone in either language, and a translation for a string that cannot be rendered is one more thing to
keep in step for no benefit. A retired term gets no translation either — "Family Code" is dead in English
and must not be revived in Hungarian.

Hungarian does not pluralise after a numeral — English "2 minutes" is "2 perc", singular. A number and a
translated noun can therefore never be concatenated at runtime: every catalogue entry containing a number
is a whole sentence with a placeholder ("{0} perc van hátra"), in both languages.

A parent's typed message to their kid is not UI text and is never translated, in either direction.
