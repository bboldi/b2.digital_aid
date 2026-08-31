# Digital Aid — Product Requirements

A self-hosted digital wellbeing system for kids' Windows PCs. A Node server (single admin, deployed on the parent's own server) holds settings and usage history; a native client app on each PC enforces time limits and keeps working offline.

Terminology used here is defined in [CONTEXT.md](./CONTEXT.md).

## 1. Guiding principles

1. **Visibility over enforcement.** The app helps kids learn healthy usage and shows the parent what happened. It is not tamper-proof and does not try to be — circumvention (killing the app, changing the clock) must be *visible in the log*, not impossible. Enforcement is the app's mechanism; teaching is the parent's job.
2. **No covert surveillance.** Transparency cuts both ways. The system records machine state — on/off, blocked, usage minutes, foreground application *name* — never content: no screenshots, no window titles, no URLs, no background process lists. The kid sees the same data about themselves that the parent sees.
3. **Offline-first enforcement.** The client enforces all rules using locally cached settings and its own clock, with no server connection required. The server is the audit trail and control panel, not a dependency.
4. **Simple over robust.** One admin, one process per side, SQLite, no queues or fingerprinting. Where robustness and simplicity conflict, pick simple and log the gap.

## 2. Roles and concepts

- **Admin** — the single parent account on the server. Exactly one.
- **Client** — one Windows machine paired with the server. All limits and history attach to the machine. Shared PCs share one budget; a kid with two machines gets two budgets. Accepted, out of scope to change.
- **Kid** — a standard (non-admin) Windows user on the Client. This is a stated installation requirement: the client app is installed by an admin account; the kid's account must not have administrator rights (this is what prevents clock changes, task edits, and uninstall — the OS does the enforcement we don't).

## 3. Time model

All rules run on the **client's local clock**; the server never arbitrates time.

- **Usage Time** — minutes during which a Windows session is logged in and *unlocked*. Lock, logout, and sleep pause the counter. Idle time with the screen unlocked still counts (no idle detection).
- **Allowance** — the Usage Time budget for one calendar date. The date picks the rate: *weekday allowance* (Mon–Fri) or *weekend allowance* (Sat–Sun), configured per Client. Resets at local midnight; each date has its own counter.
- **Downtime** — a daily window (per Client) during which the machine is blocked outright, regardless of remaining Allowance.
- **Grant** — a window of N minutes (1–999) starting at the moment of redemption during which the Client stays usable.
- **Precedence:** Grant > Downtime > Allowance. Downtime blocks even with minutes remaining; an active Grant overrides both an exhausted Allowance and Downtime (live parental intent beats standing policy). A Grant redeemed before Downtime carries past its start (30 min granted at 20:50 runs to 21:20 even if Downtime starts at 21:00).
- Internally the counter ticks on a **monotonic timer** (a minute is a minute regardless of wall clock); the wall clock only decides the date and the Downtime window. Counter state is persisted locally at least once a minute, so restarts and crashes lose nothing.
- **No Downtime:** set the window's start equal to its end (e.g. `00:00`/`00:00`). The UI states this.

### 3.1 Time Left (what "minutes left" means)
"Time Left" is what the kid can use **right now**, not the raw budget — shown identically on the Flyout
and the server. When a Grant is active, it's the Grant's remaining minutes. During Downtime with no
Grant, there is no number: it's "quiet until HH:MM". Otherwise it's the remaining Allowance. Dormant
Allowance that Downtime makes unreachable is never reported as Time Left (that was the confusing "78
minutes left during wind-down" from the first field test). The engine exposes *why* the machine is
usable and *for how long*; both surfaces render from that rather than summing allowance + grant.

### 3.2 Parent overrides
- **Lock now / Unlock** — an immediate, held block. Beats everything, including an active Grant (the
  strongest override). Stays until the Admin unlocks, or auto-releases at local midnight so a forgotten
  Lock never eats the next day. Live command, toggle. Distinct from Downtime (scheduled) and from a
  negative Adjustment (trims minutes).
- **End Today** — drains the rest of today's Time Left at once: exhausts the Allowance and clears any
  active Grant, so the Client blocks now. Not held and not permanent — a fresh Grant still gives time
  back, tomorrow's Allowance is untouched.

## 4. Secrets and authentication

| Secret | Lives | Purpose |
|---|---|---|
| Admin password | Server (hashed) | Admin login. Set at first run; changeable in the UI. |
| **Server Key** | Server DB (plain) | Signs Admin session cookies. Nothing else. Rotation just logs the admin out. |
| **Family Code secret** | Server DB + every Client (obfuscated at rest, e.g. DPAPI) | TOTP secret behind the 6-digit **Family Codes**. One shared secret for the household — one authenticator entry. Shown once at setup as QR + base32 string. |
| **Client Token** | Client (local) + server (hashed) | Permanent per-Client credential issued at pairing; authenticates the WebSocket. |
| **Report Link** | Server memory (hashed) + opened browser | Temporary 30-minute capability for one Client and one Usage Report period; never grants control or Admin access. |

**Family Codes** (standard TOTP, 6 digits, 30 s step) prove in-the-moment parental intent. They are used for: pairing a new Client, Grants, and exiting the client app. Verification happens *on the client* for Grants/exit (works offline — this is why every Client stores the secret) and on the server for pairing.

- **Rotation:** the Admin can regenerate the secret. Clients pick up the new secret on next server contact; offline Clients honour the old one until then (rotation is not an instant kill-switch).
- **Replay:** a Client remembers the last redeemed code and rejects reuse — one code cannot be redeemed twice on the same Client (also prevents a grant code from being reused to exit).
- **Grant Codes** fold the minutes into the code — `[(FamilyCode + minutes) mod 1000000][minutes]` — so changing the trailing number doesn't yield more time (the client recovers the Family Code by subtracting and verifies it). This is **casual-abuse resistance, not cryptographic binding**: a kid who deduces the subtraction recovers the code. Every redemption is logged with the minutes actually granted — the log stays the real countermeasure. Because the arithmetic isn't reliably done in the head, Grant Codes are minted by the admin UI (a minutes → code calculator); the raw code from an authenticator app is used only for pairing and exit.
- **Accepted weakness:** a determined kid can extract the secret from their machine. Consistent with principle 1.

## 5. Server

Node 22 · Fastify · better-sqlite3 · ws · server-rendered EJS + vanilla JS + vendored Pico.css. One process, one SQLite file, **no build step** — assets are self-hosted rather than CDN-loaded, because a CDN import fails in exactly the offline case the PWA exists for. Deploy behind TLS (reverse proxy) — Client Tokens and codes travel over this URL.

Pages are polled where they show *now* and left alone where they show history: the Clients grid and a
Client Page opened on today refresh themselves by swapping server-rendered HTML fragments (the same
partials the full page uses, so nothing is rendered twice); past dates, the log tables and the update
page do not poll. Polling repaints read-only regions only — never a form the Admin may be typing into.

The admin UI is a **PWA**: installable on a phone (manifest, icons, service worker, shortcuts to the
Family Code and Clients pages), so extra time can be granted from anywhere. Caching is deliberately
minimal — the static shell, an offline page, and the Family Code tab. Live state (who is online,
minutes left) is never cached: a stale answer here is a wrong answer, and cached authenticated pages
would linger on a shared phone. The Family Code tab is the exception *because* it holds no server
data — on a Trusted Device it computes codes from a locally held secret (see
[ADR-0002](./docs/adr/0002-family-code-secret-in-the-admin-browser.md)), which is precisely the thing
that must survive the server being unreachable. **Installability requires HTTPS**, so a TLS front end
is a prerequisite for the phone use case, not just good hygiene.

Navigation is three destinations — Clients, Family Code, Settings (update, password, logout) — as a
bottom tab bar on phones and a top bar on desktop. Presentation is Pico.css plus a small custom layer
for the parts that are specific to this app: the Clients grid, status dots, Time Left, the code
display.

### 5.1 First-run setup
1. First visit asks the Admin to set username/password (password stored hashed).
2. Server generates the Server Key and the Family Code secret.
3. Family Code secret is shown **once** as a QR code plus the base32 string (for saving into Google Authenticator or similar). Re-viewing requires regenerating — or making a browser a **Trusted Device** (§5.4), which hands it a copy without displaying it.

### 5.2 Admin UI
- **Login / logout / change password** (in Settings). Login offers **Remember Me** — a sliding ~30-day
  persistent session instead of a 12-hour browser-session one. Sessions are stateless and cannot be
  revoked one by one, so Settings also carries **Log out all devices**, which rotates the Server Key.
  Changing the password deliberately does *not* rotate it: silently ejecting yourself from every
  device is a surprise, and rotation should be an act the Admin chose.
- **Clients list** — the main screen: a responsive grid of rounded cards, one per Client. Each shows the
  name, a connectivity dot (green online / grey offline — connectivity *only*, so it never implies "all
  is well"), **Time Left** (§3.1) rendered in the timeline's own status colours, and the app version.
  A badge appears only when something unusual is in effect — `Disabled`, `Locked`, `Revoked` — so a badge
  always means the Admin did something deliberate that is still standing. Offline cards show their
  last-known Time Left dimmed and stamped "as of HH:MM": stale-but-labelled, rather than a confident lie
  or a blank. Cards sort by name (revoked last) and never reorder as Clients come and go; the whole card
  is the tap target.
- **Client Page** (per Client):
  - **Daily view** for a picked date (default today), stacked: a **minute timeline strip** (one cell
    per minute, colored by status active/locked/blocked/grant-active; gaps = off/offline; Event markers
    above) over **hourly bars** (per-hour minutes used, active vs blocked). Plus a **per-app list**
    (from Foreground App samples).
  - **Time Left** now, prominently (§3.1).
  - Settings: Downtime window, weekday Allowance, weekend Allowance.
  - Actions: send message, Adjustment (±minutes), **Lock now / Unlock** (§3.2), **End Today** (§3.2),
    remote kill, **upload/announce update** (§6.7), rename, revoke/delete.
- **Requests page** — one screen for the whole household, reached from its own nav tab with a live count
  badge, because it is the only screen where somebody else puts work on the Admin: a notification says
  *someone* asked, not who. Each open Request shows who asked, for how many minutes, when, and how long
  it stays answerable — plus an `offline` badge when that PC is not connected, since approving anyway is
  still the right move (the verdict waits up to 30 minutes for it to come back). The minutes box is
  pre-filled with what was asked but is a plain number field: the ask is advisory and the Admin gives
  what they think is right. Below the open ones, a short history — including the lapsed ones, so
  "I approved 30 minutes and she says she never got them" has an answer on the page.
- **Logs page** (per Client, linked from the Client Page) — the raw Ping and Event tables, paginated.
  The Client Page is graphical; the raw rows live here for when they're actually needed.
- **Family Code** — top to bottom: the **Grant Code** first, since it is the daily-use thing. Minute
  presets (10 · 15 · 30 · 45 · 60 · custom 1–999) pick the amount, the last choice is remembered on the
  device, and one oversized code is shown with a copy button and the minutes echoed in words ("30
  minutes for one PC") — an 8-digit number carries no clue about what it does, and handing over the
  wrong one has no undo. Below it the raw **current 6-digit code** (pairing and exit) with its own copy
  button, then **Trusted Device** (§5.4), then the `[code][minutes]` format explained, then Regenerate.
  Validity is reported as the true acceptance window: verification allows ±1 step on both server and
  Client, so a displayed code is good for roughly 30–60 seconds, not the 0–30 a naive countdown implies.
  Copy confirmations carry that remaining validity, because copying exists for sending a code to someone
  remotely — a clipboard does not reach the kid's PC.
  The secret itself is never re-shown, only regenerated (with confirmation; shows new QR once). The
  format is documented **only here**: the Block Screen deliberately never explains it, since a kid who
  knows the minutes are typed on the end knows they can claim 999 of them.
- **Client update** — upload a new client exe; server stores it as "latest" with its SHA-256; clients report their version in every Ping.

### 5.3 Client management
- **Pairing:** client submits server URL + a current Family Code (+ its PC name). Server verifies the code, creates a **new** Client row, issues a Client Token (stored hashed). Pairing always creates a new Client — no machine fingerprinting; the Admin deletes stale rows (history stays until deletion).
- **Revoke:** invalidates the token; the client's next connection attempt is rejected. A revoked client keeps enforcing its last-known settings standalone — revoke ≠ remote uninstall.
- **Disable / Enable:** a resident **pause**, remotely reversible (there is no hard "kill"). The
  server owns the `disabled` flag; the toggle on the Client Page sends a live `disable`/`enable`
  command and clients also **reconcile to it via `hello`** (so a toggle made while a Client was briefly
  offline still lands on reconnect). A disabled Client keeps running and connected but enforces nothing
  and counts no time — for the kid it's indistinguishable from off, and Enable brings it back
  instantly. Disabled state is cached locally, so a disabled Client that restarts offline comes up
  paused and unrestricted (the safe failure) until it reconnects. `DigitalAid.exe --status` prints the
  local state. (Permanent removal is what uninstall is for.)

### 5.4 Trusted Device (offline Family Codes)

The moment the Family Code is most needed is the moment the server is unreachable: the kid is blocked
and the parent wants to hand over a Grant Code. So the Admin can make one browser a **Trusted Device** —
an explicit opt-in on the Family Code page, gated by re-entering the admin password (an unlocked phone
with a live session is not proof of anything). The server then sends the secret once; the browser keeps
it in IndexedDB and computes Family Codes and Grant Codes itself via WebCrypto (HMAC-SHA-1 is native —
no crypto library is needed, only base32 decoding).

That code path is used **online as well as offline**, deliberately: an offline mode that only runs
during an outage is only tested during one. Browsers that have not opted in keep asking the server and
simply lose the tab when it is unreachable, falling back to the mental-arithmetic explanation.

Trust is per-browser and cannot be revoked remotely — regenerating the secret is what makes stored
copies inert. Rationale and rejected alternatives:
[ADR-0002](./docs/adr/0002-family-code-secret-in-the-admin-browser.md).

### 5.5 Data (SQLite, sketch)
`admin` (single row: username, password hash, server key, totp secret) · `clients` (id, name, token hash, version, created/revoked) · `settings` (per client: downtime window, weekday/weekend minutes) · `pings` (client, server timestamp, status, remaining minutes, foreground app) · `events` (client, client timestamp, server received-at, type, payload) · `requests` (client, minutes asked, state, minutes granted, created/expires/decided/delivered) · `updates` (version, file, sha256, uploaded at) · `daily_usage` (client, local date, used/blocked minutes, longest session, per-app JSON). Pings are ~1 row/min/client (~500k/year, ~66 MB); after 30 days they are folded into one `daily_usage` row per client per day and deleted (ADR-0003). Minute-level detail has a shelf life, the summary does not.

## 6. Client

.NET 10 (LTS), C#. Two projects:
- **`Client.Core`** (`net10.0`, no Windows dependency) — the usage-time state machine, Allowance/Downtime/Grant rules, TOTP verification, protocol, offline queue, persistence. Fully unit-tested (xUnit); tests run on Linux.
- **`Client.App`** (`net10.0-windows`, WPF) — thin shell: tray icon, Flyout, Block Screen, toasts, Win32/session-event wiring, WebSocket transport. Translates OS events into `Client.Core` calls.

Published as a **framework-dependent** single `win-x64` exe (~270 KB), cross-compiled from Linux via
`EnableWindowsTargeting`. Self-contained would be ~166 MB; since self-update ships this file to every
Client, small wins. Cost: the .NET 10 Desktop Runtime is a one-time per-machine prerequisite installed
by the parent (`winget install Microsoft.DotNet.DesktopRuntime.10`).

### 6.1 Installation & keep-alive
- Installed by a parent/admin account into a machine-wide, **app-writable** directory (e.g. `ProgramData\DigitalAid` — writable is required for self-update; file tampering is accepted per principle 1, since killing the process was always easier and equally visible).
- Registered as a **Scheduled Task** by `client/install/Install-DigitalAid.ps1` (elevated, run once per
  PC by the parent): two triggers — at logon of any user, and every minute thereafter, with
  `MultipleInstances=IgnoreNew` so the relaunch is a no-op while the app is alive. It runs as
  `BUILTIN\Users`, unelevated, so it draws windows in whichever kid's session is active. Created by an
  admin, so a standard user cannot edit or delete it. Windows is the watchdog — no second process, no
  mutual-restart pair. `Uninstall-DigitalAid.ps1` removes it (keeping local state unless `-Purge`).
- The task runs the exe with `--scheduled`, which is how the app tells the watchdog apart from a person
  starting it. That distinction is what makes [[Stood Down]] work: an exit by Family Code turns the
  watchdog away until local midnight or the next reboot, while double-clicking the exe brings
  protection straight back (ADR-0004).
- Killing the app costs the kid a ≤1-minute gap and paints an unclean-exit stripe in the log. Accepted.
  *Exiting* it with a Family Code is different and deliberate: that lasts until midnight or reboot, and
  is logged as `exit-via-code` with `stoodDown`.
- **Rejected: hiding the process from Task Manager.** Not achievable without rootkit techniques, and it
  contradicts visibility-over-enforcement (the app being sneaky is the thing we don't build). If a kid
  ever turns repeated killing into a game, the answer is the **deferred Windows Service** upgrade
  (enforcement as a SYSTEM service a standard user can't end + a UI agent it relaunches; Client.Core
  doesn't move) — not hiding. Until then: install the task, watch the log.

### 6.2 Enforcement behaviour
- Counts Usage Time per §3; persists counter + date + active Grant every minute and on every state change.
- **Warnings:** non-focus toasts at ~15 and ~5 minutes of remaining time, and before Downtime. A negative Adjustment that empties remaining time warns ~1 minute before blocking.
- **Block Screen:** fullscreen, topmost (re-asserted every ~2 seconds), covering **all monitors**, keyboard focus captured. Before showing, the current foreground window is sent a minimize (best-effort pause for games). While it remains up, an ordinary application that takes foreground is minimized and focus returns to the open Digital Aid dialog, or otherwise to the primary cover. Digital Aid's own windows and Windows accessibility input are left alone; shell surfaces are covered again without minimizing the shell. Everything is best-effort within the unelevated desktop session. Shows why (time's up / downtime until HH:MM) and **one input field accepting only Grants**: exactly 6 digits of code + 1–3 digits of minutes, parsed unambiguously since TOTP codes are always 6 digits. Bare codes do nothing here.
- **Exit protection:** a deliberate action prompting for a Family Code, from the tray menu or the Block Screen (which covers the taskbar, so while blocked it is the only reachable surface). Logged as an Event. The no-reuse rule prevents a code already spent on a Grant from also exiting. Exiting this way **stands the app down**: the Scheduled Task stops restarting it until local midnight, the next reboot, or someone starts it by hand (ADR-0004). This is the one override that cannot be reversed from the server — nothing is left running to receive the command.
- **Ask for more time:** in the tray menu and on the Block Screen, next to the Grant input — the only
  kid→parent action in the product (CONTEXT.md: Request). Three fixed choices (15 · 30 · 60 minutes) and
  no message field: the number is advisory anyway, and a free-text box would turn asking into justifying.
  Sent live only; if the server is unreachable the kid is told so rather than left waiting on an ask
  nobody received. Hidden during an admin Lock, since extra minutes would not lift one. An approval
  arrives as a Grant and lifts the Block Screen immediately; a decline arrives as a message that must be
  dismissed, followed by a 15-minute quiet period before asking again.
- **Shut down:** a Block Screen button, no code required. A kid can hold the power button anyway, so gating it would be theatre, and a clean shutdown logs `os-shutdown` where a held power button logs `unclean-exit`.
- **Flyout** (tray click): remaining time today and next Downtime.
- **Usage Report** (tray submenu): the same 7/30/90/120-day report the Admin can open, including daily Usage Time, blocked time, Allowance, and Foreground App statistics. Visible but disabled while offline. The Client requests a 30-minute Report Link over its authenticated socket and opens it in the default browser; the link grants read-only access to that Client and period only.
- **Popups** (warnings and messages) appear **top-center** of the primary screen — big centered title,
  readable body, an ✕ plus an OK button — as topmost, **non-activating** toasts that never steal focus
  from a game. Positioned in device pixels (DPI-correct), so nothing runs off the edge. **Warnings**
  auto-dismiss (~15 s) but can be closed sooner; **parent messages** persist until the kid closes them
  (the point is that it was seen) and are logged `message-shown` when shown. No reply.

### 6.3 Foreground App sampling
Once per minute, record the foreground application's **product/exe name only** (e.g. "Minecraft"). Never window titles, URLs, or process lists. Rides the Ping; feeds the per-app statistics on the Client Page and Usage Report.

### 6.4 Offline behaviour
- Settings (Allowance, Downtime) are cached locally on every sync; enforcement never needs the server.
- Pings/Events generated while offline are **queued locally and flushed on reconnect** — the timeline heals itself.
- Grants and exit work offline (local TOTP verification).
- Server→client commands are **live-only**: no server-side command queue. A message/kill/Adjustment sent to an offline client is dropped and the UI says so.

### 6.5 Clock handling
- Standard-user kids cannot change the system clock (OS-enforced) — the primary mitigation.
- The client compares wall-clock progression against its monotonic timer; a jump beyond a small threshold logs a **clock-jump Event**. Minutes cannot be erased by clock changes (monotonic ticking); tampering can only shift dates/windows, and it leaves a mark.
- The server stamps every received Ping with **its own** clock — the ping log is the parent's audit trail, independent of the client clock. Gaps mean off/offline/killed, and that is information.

### 6.6 Events
Logged locally, synced (queued offline), colored on the timeline: grant redeemed (with minutes), adjustment applied, update installed, clock jump, message shown, exit-via-code (with whether it stood the app down), remote kill, OS shutdown, server unreachable, **unclean exit**. Unclean exit (kill / crash / power loss — indistinguishable, deliberately) is inferred at next startup from a still-present "running" marker file, stamped with the last persisted tick time. Clean exits clear the marker and log their reason first.

### 6.7 Self-update
The **decision key is the exe's own SHA-256** — the running client hashes its own file (`ProcessPath`,
stable even for a single-file publish) and compares it to the hash the server announces. Nothing about
"last installed version" is persisted: the running exe *is* the source of truth, so the check is
self-correcting (a half-failed swap just re-triggers next time) and never spuriously re-downloads the
build it already runs. A typed **version label** and the **upload timestamp** are carried for display,
ordering, and the `update-installed {from, to}` log only — not for the decision.

1. The Admin uploads an exe on the Client Page (whole fleet, no per-machine staging) and optionally
   types a version label; the server stores it as "latest" with its SHA-256 and upload time.
2. The latest hash is **announced in `hello` on every connect** (covers app start, reconnect, and a
   machine that was offline during the upload) and **pushed live to all connected clients on upload**.
   No polling — the socket makes both free.
3. If the announced hash differs from its own, the client downloads in the background over the
   authenticated `x-client-token`, verifies the download hashes to the announced value (mismatch →
   discard + `update-rejected` Event, no retry loop since it only acts on a *differing announced hash*).
4. Swap: rename the running exe to `.old`, move the new exe into place, **clear the run-marker** (so the
   restart is not logged as an unclean exit), exit cleanly. The Scheduled Task relaunches within a
   minute; state was persisted, nothing is lost; the version change is logged `update-installed`.
5. Previous exe kept one generation as `.old` for manual rollback. Version reported in every Ping.

## 7. Protocol

- **Pairing:** one HTTPS POST (server URL + Family Code + PC name → Client Token or rejection).
- **Everything else:** one WebSocket per client, Client Token presented at connect, automatic reconnect with backoff. Being connected is being online; liveness via protocol ping/pong.
  - **Client → server:** minutely status snapshot (status: active/locked/blocked/grant-active, remaining minutes, version, foreground app), Event batches (incl. offline backlog), Report Link requests.
  - **Server → client:** settings update, Adjustment, message, remote kill, update-available (version + hash + URL), rotated Family Code secret, Report Links.

## 8. Development workflow

Development on Arch Linux: server runs natively (Node 22); client logic (`Client.Core`) is built and unit-tested here; the Windows exe is cross-compiled here. Integration testing (Block Screen vs. games, session-lock events, topmost behaviour) happens on a Windows VM (git + Claude Desktop, via remote control).

## 9. Out of scope (deliberate)

- Screenshots or any content capture — dropped on principle, not deferred.
- Per-child budgets shared across devices (Client = machine, full stop).
- Tamper-proofing beyond the standard-user assumption (no service watchdog pairs, no self-defense).
- Idle detection (unlocked = counting).
- Server-side command queues, machine fingerprinting, multi-admin, non-Windows clients.
