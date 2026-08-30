# Status & next steps

_Last updated: 2026-08-20 — grilling session: Install Kit (`/download`) + asset cache busting (see below)._

Read first: [PRD.md](./PRD.md) (full spec, wins over brainstorm.txt) and [CONTEXT.md](./CONTEXT.md) (glossary — use these terms).

## Done

- PRD + glossary finalized after a full design grilling.
- `server/` scaffolded and smoke-tested end to end (Node 22 · Fastify · better-sqlite3 · ws · EJS):
  first-run setup with one-time QR, login (scrypt + HMAC-signed cookie), `POST /api/pair` (TOTP → Client Token),
  WebSocket ingest of pings/events (`x-client-token` **header** auth — never put the token in the URL, it leaks into logs),
  admin pages (clients list, Client Page with settings/message/adjust/kill/rename/revoke/delete, Family Code regenerate).
  Run: `cd server && npm install && npm run dev` (env `PORT`, `DB_FILE`).
- [PROTOCOL.md](./PROTOCOL.md) — message shapes frozen against the **server code**, not the PRD prose:
  pairing, header auth + `4001`, `ping`/`events`, all six live commands, `update` (shape frozen, not yet emitted),
  status + Event-type vocabularies, settings defaults.
- Server updated to protocol 1: `events.seq` + unique index, `clients.protocol`, `lastSeq` in `hello`,
  raw ping status, protocol badge in the admin UI. `src/protocol.js` holds the version constant.
  Schema migrates additively on open (`addColumn` + `CREATE UNIQUE INDEX IF NOT EXISTS`) — an existing dev DB
  is upgraded in place, old seq-less Event rows survive as NULL. Verified on the dev box against real
  better-sqlite3: migration of a pre-seq DB (11 assertions) + live end-to-end incl. replay dedup (10 assertions).
- `client/` solution (.NET **10** — Arch ships only the 10 runtime, so the PRD's ".NET 8" became "10 (LTS)"):
  `Client.Core` (`net10.0`, zero Windows deps) with the **enforcement engine** — pure `Tick(now, elapsed, unlocked)`
  state machine implementing Grant > Downtime > Allowance, monotonic accrual (clock jumps detected, never erase
  minutes), midnight flip, 15/5-minute warnings, negative-Adjustment 1-minute grace, grant/exit code no-reuse —
  plus RFC 6238 TOTP (cross-checked against the server's otplib with fixtures) and Grant-code parsing.
  Persistence: `StateStore` (atomic temp+move JSON; corrupt file quarantined, never silently dropped),
  `EventQueue` (append-only JSONL, two-phase take/commit so a crash re-delivers instead of losing —
  safe because the server dedupes on `seq`), `RunMarker` (unclean-exit inference), `Protocol.cs`
  (message DTOs + tolerant parser: unknown/malformed messages degrade to `Unsupported`, never throw).
  **97 xUnit tests green on Linux** (`cd client && dotnet test`) plus a real interop pass against the
  live Node server: Client.Core's own TOTP code paired, `hello` parsed, pings/events round-tripped,
  batch replay deduped to 3 rows, bad token → 4001. C# and JS provably speak the same protocol.

## Protocol decisions — settled (grilling session, 2026-08-18)

All four resolved and implemented server-side; nothing blocks `Client.Core` now.

1. **Event delivery** → per-Client monotonic `seq` + `UNIQUE(client_id, seq)` + `INSERT OR IGNORE`. No ack. `hello` carries `lastSeq` so a Client can resync after partial state loss. Recorded in [ADR-0001](./docs/adr/0001-event-sequence-numbers-not-acks.md).
   **Client.Core consequence:** the Client Token and `next_seq` live in the *same* state file — losing it un-pairs, which allocates a fresh `client_id` and makes seq collision structurally impossible. Do not split them.
2. **Protocol version** → `protocol: 1` in the pair request, in `ping`, and in `hello`. Advisory: logged and badged in the admin UI, never fatal. `PROTOCOL.md` is the authority for the number.
3. **Ping status** → stored verbatim; unknown values logged, never coerced. The audit trail must not fabricate.
4. **Update download** → `x-client-token` header, same as the socket; announce carries a **relative `path`**, not a URL (the server is behind a proxy and cannot know its own origin).

## Time Coupons — BUILT (2026-08-21)

**Built.** Server 190 tests green, client 316 green. Glossary term added (**Time Coupon**) and [ADR-0017](./docs/adr/0017-time-coupons-are-lettered-server-checked-and-top-up-the-allowance.md) written.

1. **Lettered coupons:** 6 uppercase consonants + 3 digits (e.g. `KRT-VXM-030`). Handled gracefully by the shared UI box.
2. **Online-only:** Checked and recorded in the server database.
3. **Allowance top-up:** Redeeming a coupon adds its minutes to today's `Allowance`, not a Grant. Downtime still overrides it.
4. **Admin UI:** Added a Time Coupons page to mint, view, delete, copy, and print coupons.

## Grilling session, 2026-08-21 — Admin UI reskin: Beer CSS / Material 3 — BUILT

**Built.** Server **171** tests green. [ADR-0016](./docs/adr/0016-the-admin-ui-skin-is-beer-css-on-server-rendered-ejs.md)
written (number reused from the deleted 2026-08-20 one). After two failed restyles, the user
themselves reopened the Pico question; the grilling settled: **SSR stays** (no Ionic/SPA — a build
step and client router would rewrite live.js, i18n and the service worker), only the skin changes.

1. **Beer CSS v5 vendored** at `public/vendor/beer.min.css` (Pico removed from package.json and
   vendor/). `style.css` fully rewritten: M3 tokens seeded from grant-blue `#2b5cd9`, `--da-*`
   status palette kept, dark mode via `prefers-color-scheme` (no picker — that died with the
   rejected redesign). Taste anchor: **Google Family Link**; approved from static mockups
   (screenshots, light+dark, phone width) *before* any real view changed — that process guard is
   the lesson of the two failures.
2. **Shell**: appbar (brand only) + one `nav.tabbar` that is a bottom pill-bar on phones and a left
   rail ≥46rem. Client cards: avatar, status chip (`kind.*` i18n keys added, en+hu), big calm
   Time Left, and a **24-h ribbon of the day** on the card (`clientCards()` now attaches
   `dailyData().segments` per client).
3. **Beer fights documented in ADR/style.css**: it grids `body:has(>main)` (opted out), hides
   `input[type=file]` and SVG fills (restored), and owns `.badge/.row/.tabs/.page/.chip/.small` —
   ours renamed to `.tag`/`.inline-row`/`.seg-tabs`. Timeline/day SVGs now use `var(--da-*)` so
   dark mode reaches them.
4. **Untested on a real phone yet**: PWA install, the rail on a desktop browser, and the live.js
   fragment swap under the new markup (fragments render the same partials, so low risk).

**Follow-up round (same day), after first real look.** Quick actions became three buttons opening
native `<dialog>`s (Give time / Send message / Lock-with-confirmation; Unlock posts straight — it
only gives back); dialog plumbing in `public/quick-actions.js`, Beer styles `[open]` dialogs
natively. `details.collapse` sections: Block screen backgrounds (client page + Settings) and Client
update — which absorbed the Versions-in-the-field and Uploaded-builds tables — collapsed by
default. Bug found by the user: Beer lacks Pico's `[hidden]{display:none!important}`, so the Codes
page's offline/no-crypto strips showed on a healthy server — rule restored in style.css.
`codes.extraTag` corrected to "9 digits" (ADR-0014 pads to nine). Sessions logout buttons aligned
via `.inline-row form{display:contents}`. Two quick-actions tests re-anchored (`quick-row` →
`.quick`/`dlg-give`); **171 green**.



**Built.** Server **171** tests green (was 137), client **276** green. Glossary term added
([[Install Kit]], _telepítőcsomag_) and
[ADR-0015](./docs/adr/0015-the-install-kit-downloads-without-a-login.md) written.

New server files: `src/zip.js` (a minimal ZIP writer — no dependency, verified against the system
`unzip`), `src/install-kit.js`, `src/assets.js`, `src/routes/download.js`, `views/download.ejs`,
`test/install-kit.test.js`, `test/assets.test.js`. 18 new i18n keys in both catalogues.

**The gap.** `GET /api/update/latest` authenticates with `x-client-token`, so only an already-paired
machine can fetch a build — a fresh PC cannot get the thing that lets it pair. The install scripts
never shipped at all.

**Decided:**

1. **`/download`, unauthenticated**, linked from `/login` and from `/clients` — the front page a
   logged-in admin actually lands on, and where "I need another PC on this" occurs to someone. A
   button in the empty state, a footer link otherwise, and outside the live-refreshed grid fragment
   either way. Reasoning and the rejected alternatives (login-gated, secret URL, rate limit) are in
   ADR-0015. `noindex` + `robots.txt` disallow.
2. **One flat zip**: `DigitalAid.exe` + the four scripts at the top level. Both `Install-DigitalAid.bat`
   and `.ps1` must look for the exe *beside themselves* first, falling back to `..\dist\` so repo use
   keeps working (today they hardcode the repo layout — `.bat:20`, `.ps1:35`).
3. **Scripts read from `../client/install/`** on the deployed checkout, at request time; zip built per
   request, never prebuilt. Directory absent → page says so, does not ship a kit without an installer.
4. **Latest build only**, version number shown, no history, no hashes, no Client names.
5. **Empty state** when there is no build — and the same when the row exists but the file does not
   (the `410` case; happens when a DB is restored without the `updates/` directory). `/login` hides
   the link in that state; the page itself never 404s.
6. **Three-step "what's next"** on the page: runtime if prompted → run the `.bat`, approve UAC →
   pair from the tray with an [[Admin Code]]. A kit that installs but never pairs leaves an
   [[Unconfigured]] Client: running, in the tray, enforcing nothing.
7. **Installer offers to run `winget install Microsoft.DotNet.DesktopRuntime.10`** when
   `Assert-DesktopRuntime` (`.ps1:44`) finds none — with `--accept-source-agreements`, an explicit
   exit-code check, and a clean fall-through to today's printed instruction. It may well not fire:
   the `.bat` elevates, so on the kid's standard account the elevated session runs as the *parent's*
   account, where winget (per-user MSIX) may never have been provisioned. Hence the page copy too.
8. **`Unblock-File`** on the exe and the scripts. `Copy-Item` (`.ps1:63`) preserves `Zone.Identifier`,
   so a browser-downloaded exe would carry Mark of the Web into ProgramData and into a Scheduled Task
   that launches it every minute, unattended. Self-update is unaffected — no browser, no zone.
9. **Rejected: shipping a self-contained exe in the kit.** It works until the first self-update
   replaces it with the 273 KB framework-dependent build, on a machine with no runtime, after the
   parent has left the room.
10. **Fix a glossary violation**: `Install-DigitalAid.ps1:106` prints "Exiting with a Family Code" to
    the parent, and line 71's comment says the same. "Family Code" is dead — it is the **Admin Code**.

**Asset cache busting (separate, same session).** A CSS change renders stale exactly once per device:
`public/sw.js:73` serves `/public/` cache-first with a background refresh (`return cached || fresh`),
and `CACHE = 'digital-aid-shell-v6'` is a hand-bumped constant. `layout.ejs:26` carries no version on
the URL, so nothing ever tells a cache the bytes changed. `@fastify/static` is *not* the culprit — it
is registered with no `maxAge` (`app.js:77`) and revalidates normally.

Fix: **content-hashed URLs.** Hash each asset at boot, emit `/public/style.css?v=<hash>` from
`layout.ejs`, and inject the same hashes into `SHELL` in `/sw.js` — which is already served through a
route (`app.js:100`), so it can be templated. `CACHE` then derives from the hashes and can never be
forgotten. Cache-first stays, which matters: `/family-code` is the one screen that must survive a dead
server, so network-first was rejected as the wrong default for it. No build step.

**Open, not opened.** There is no glossary term for **the exe itself**. The code calls it "build",
"update" and "the exe"; it reaches a screen in three places (Settings upload list, the Client Page
version column, and now the Install Kit page). Worth one term, in both languages.

**Unverified — needs the Windows VM.** There is no PowerShell on the dev box, so every change to
`Install-DigitalAid.ps1` is eyeballed only: the beside-first exe resolution, the winget offer, and
`Unblock-File`. Three bugs were found by reading and fixed before commit, which is the argument for
running it on the VM before trusting it:

- `Get-ChildItem -Path $scriptDir -Include '*.ps1'` matches **nothing** unless the path ends in a
  wildcard. The Unblock pass over the scripts was a silent no-op as first written.
- `& dotnet --list-runtimes` on a PC with **no .NET at all** is a *terminating* error under
  `$ErrorActionPreference = 'Stop'` — a stack trace on precisely the machine the check exists for.
  This was latent in the original and became reachable the moment the kit started targeting fresh
  PCs. `Test-DesktopRuntime` now checks `Program Files\dotnet\shared\...` first.
- PATH changes do not reach a running process, so the post-winget re-check could report failure after
  a successful install. Same directory check covers it.

**Unverified.** Reported this session: the Client Page top bar renders badly on an installed mobile
PWA ("icons are bad"). Screenshot was inconclusive — the floating panels in it are Android's volume
overlay. Recheck once cache busting lands; it may have been the stale stylesheet all along.

## Grilling session, 2026-08-20 (second) — Alerts, nine-digit codes, tray bug

Tests: **server 137, client 276, all green**; `Client.App` still cross-compiles to `dist/DigitalAid.exe`.
No protocol change and no new Event type, so an un-updated PC keeps working throughout.

- **Alerts (new).** Web Push from zero — there was no notification system at all; what looked like one
  was the nav badge, which only counts while a tab is open. New: `src/push.js` (VAPID beside the
  Server Key, subscriptions keyed on endpoint, prune on 404/410), `src/alerts.js` (the pure
  classifier), `src/alert-service.js` (composes the sentence, holds the batch, sends), push and
  notificationclick handlers in `public/sw.js`, `public/alerts.js` for the permission flow, and an
  Alerts section on the settings page. Four kinds, household-wide switches, everyone gets everything,
  no action buttons. Request → `/requests`; the three status ones → `/clients/:id`.
  Derived from **Ping transitions, not Events** — [ADR-0013](./docs/adr/0013-alerts-are-derived-from-ping-transitions.md)
  has the reasoning and every number (10-minute gap, 10-minute lock damping, `exhausted`-only,
  the two came-on suppressions, the accepted false positive after a long outage).
  `npm install` needed: adds **web-push**.
- **Extra Time Codes are nine digits.** Minutes zero-padded to three, written `482-102-015`.
  The padding is in the written form only — the HMAC still signs the bare integer — which is why a
  padded code verifies on a Client that has not been updated. Dashes are shown everywhere and never
  copied: the clipboard carries bare digits, because an older `TryParse` rejects anything non-numeric.
  All three implementations and both vector sets moved together. [ADR-0014](./docs/adr/0014-extra-time-codes-are-nine-digits-padding-is-not-signed.md).
  The Admin Code is untouched — six digits, ungrouped, as the authenticator renders it.
- **Tray double-click bug — fixed.** `_tray.DoubleClick +=` lived inside `BuildTrayMenu()`, which
  `ChooseLanguage()` calls again to re-caption the menu, so handlers accumulated and every language
  switch added another Flyout per double-click. Subscription moved to one-time init; `ShowFlyout()`
  and About also gained single-instance guards (Flyout closes-and-reopens, because it is built from a
  snapshot of Time Left and a raised stale one would show the wrong minutes).

### Still unverified on real hardware

- **Alerts need HTTPS with a real certificate** — service workers and `PushManager` are secure-context
  only and a self-signed cert will not do. Test against a real TLS host
  (`tailscale serve --bg 3000`), never the LAN IP. The server also needs **outbound** internet to reach
  the push services: this is the first feature here that does, and it fails quietly without it.
- **The tray fix has a testable prediction**: two Flyouts should only ever have appeared after a
  language switch in that session. Two on a clean start means the diagnosis was wrong.
- Nothing above has been seen on a real phone yet — Android (installed PWA preferred: the Alert then
  carries the app's own icon and name and gets its own notification channel).

## Grilling session, 2026-08-20 — built end to end

Wording, branding, versioning, i18n, and one real bug. Tests: server 107, client 226, all green;
`Client.App` still cross-compiles to `dist/DigitalAid.exe`.

- **Block Screen Background cold-start bug — fixed.** `BackgroundStore` only knew which picture was
  current from the last `hello`, so a cold start straight into a block (scheduler restart with the day
  already spent) drew a plain cover while `blocked.img` sat on disk — and an *offline* Client never
  showed one at all, contradicting the class's own doc comment. `Resolve()` now keys off the hash file
  on disk, which was already authoritative because clearing a slot deletes both files. The file/hash
  half moved to `Client.Core/BackgroundFiles.cs` with 11 tests; only the `BitmapSource` decode is left
  in the Windows-only shell, which is where this hid.
- **Warnings name which limit is coming.** "Less than 15/5 minutes left" vs "…until downtime", from a
  new `BlockCause` the engine returns alongside the seconds. Recomputed at each firing, never latched.
- **Branding + MIT.** Root `LICENSE` and `README.md` (there was no root README at all), attribution on
  the client About window and a new server Settings → About, `Company`/`Product`/`Copyright` in the PE,
  `author`/`license`/`homepage` in `package.json`.
- **Server versioning.** `src/version.js` derives the running version from `package.json` plus
  `+dev.<sha>` when the tree is not on its release tag — the server has no build step, so the running
  server *is* the working tree. `server/publish.sh` bumps, commits and tags `server-vX.Y.Z`.
  No auto-update, deliberately ([ADR-0011](./docs/adr/0011-the-server-does-not-auto-update.md)).
- **i18n, English + Hungarian.** Two independent settings: server Settings for the admin UI, tray
  submenu for each PC ([ADR-0012](./docs/adr/0012-language-is-chosen-on-the-client.md)). `Client.Core`
  now emits structured intent (`NoticeKind`, `BlockCause`, minutes) instead of English prose. Hungarian
  glossary fixed in [CONTEXT.md](./CONTEXT.md) *before* any string was translated. Both sides have
  parity tests; the client's satellite assembly is verified to embed in the single-file exe, so
  Hungarian survives a self-update.

**Still to test on the VM:** the tray Language submenu (rebuilds the menu and re-captions a cover that
is already up), and the Block Screen Background actually appearing on a cold start into a block — the
bug above was found by reading, and the fix is proven by tests on Linux, not by a Windows run.

## Next (agreed order — thin vertical slice)

1. **`client/Client.Core`** — **done** (engine, TOTP, grant parsing, state store, event queue, run marker, protocol DTOs). Remaining: a coordinator that wires engine+queue+socket together, and the self-update download/verify/swap helper.
2. **`client/Client.App`** — **built and cross-compiling** (tray, Block Screen on all monitors with grant input, non-activating toasts, pairing/exit dialogs, Flyout, WebSocket link, session-lock + foreground-app plumbing). `./publish.sh` produces `dist/DigitalAid.exe`. **Never run on Windows yet** — next step is the VM: does the Block Screen actually beat a fullscreen game, do session-lock events fire, does the tray behave.

## Parked (deliberately, until the slice works)

- Server: timeline visualization + per-app chart (Client Page shows plain tables), client-exe upload/update-announce routes (`updates` table exists), automated tests (`npm test` wired for `node --test`).

## Dev environment

- Dev box: Arch Linux; .NET SDK 10 installed (targets `net10.0`). Server runs natively.
- Windows 11 VM (VirtualBox, bridged): test bench for the client. Shared folder from the dev box (read-only ideally) as a drop zone for built exes; the dev box owns the working tree — if the VM session must edit code, use a separate git clone, not the shared tree.
- VM reaches the dev server at the dev box's LAN IP.
- VM gotchas (learned the hard way): git needs `git config --global --add safe.directory '%(prefix)///VBoxSvr/digital_aid/'` or every command dies with "dubious ownership". `server/node_modules` holds a **Linux** `better_sqlite3.node` (ELF) — never run `npm install` from the VM against the shared tree, it swaps in a Windows DLL and breaks the dev box. Windows only ever needs the .NET **Desktop Runtime**, never the SDK.
- Skills (`.agents/` + `.claude/skills/`, `skills-lock.json`) installed via `npx skills add` — `grill-with-docs` is a shim, it needs `grilling` + `domain-modeling` installed alongside it or it half-fires.

## Field feedback — round 1 (2026-08-18, first real Windows test)

Triaged from a live VM run. **B**=bug, **D**=design (grill), **A**=already answered.

1. (D) Client Page pings/events are unpaginated raw tables — move raw logs to their own page; put a
   graphical daily-usage view on the Client Page. **Grill the chart.**
2. (D) Stats: daily usage, per-app breakdown, a 24h bar chart (per hour: how much, active vs not).
3. (B+D) Toast popup: right edge off-screen (Width in DIPs vs SetWindowPos device px — confirmed),
   no close button, wants larger centered fonts, bigger for time/message. Redesign + fix DPI.
4. (D) "Revoke time" button — take back a client's remaining time / lock instantly. Grill vs adjust.
5. (A+D) Task Manager kill didn't restart → expected, the Scheduled Task (installer) wasn't run yet.
   Open design Q: hide the process / make it harder to end.
6. (D→impl) Remote software update (PRD §6.7): upload exe to server, client downloads/verifies/swaps.
7. (B) Current remaining minutes not shown on the server — only configured limits. Surface it.
8. (B?) Grant from an about-to-expire code applied; flyout then showed "78 minutes left / extra time
   running" during downtime, and a "5 minutes" appeared somewhere. Needs log diagnosis. Likely two
   things: (a) "remaining" during downtime reports full untouched allowance = misleading; (b) the
   "5 minutes" source is unknown — get client.log.
9. (A) No downtime = set start==end (e.g. 00:00/00:00). Works today; make the UI say so.

## Field feedback — round 1 status (implemented 2026-08-18)

Done and verified on the dev box (client 136 tests + server e2e), pending Windows run:
1. ✅ Logs → paginated /clients/:id/logs; Client Page is graphical.
2. ✅ Daily view: minute timeline strip + hourly bars + per-app + day picker (SVG, offline-safe).
3. ✅ Toast redesigned: top-center, DPI-correct positioning, ✕ + OK, big centered text; warnings
   auto-dismiss (15s), parent messages persist.
4. ✅ Lock now/Unlock (beats grants, midnight auto-release) + End Today buttons + engine + commands.
5. ⏳ Kill-restart = install the Scheduled Task (installer written); hiding rejected by design.
6. ✅ Self-update: sha256-keyed, upload/announce/download/verify/swap all implemented + e2e tested.
7. ✅ Time Left shown on Clients list + Client Page (usable-now).
8. ✅ Root cause = "remaining during downtime" reported dormant allowance; fixed by Time Left model.
   Still want client.log to confirm the stray "5 minutes".
9. ✅ No-downtime = equal start/end; UI now says so.

## Still to verify on Windows (VM)
- Block Screen vs a real fullscreen game, including Alt+Tab recovery; multi-monitor coverage; on-screen keyboard exemption.
- Toast top-center DPI positioning on a scaled display.
- Self-update swap+restart on a real machine (rename running exe, Scheduled Task relaunch).
- Lock/End Today/update-upload round trips against a paired real client.
- Install-DigitalAid.ps1 (untested — no PowerShell on dev box).

## Field feedback — round 2 (implemented 2026-08-18 evening)

All committed; dev-box tested, pending Windows run:
- Grant Codes now fold minutes in: [(FamilyCode+minutes) mod 1e6][minutes]. Admin page has a
  minutes→code calculator + mental-math explainer. Raw code is pairing/exit only.
- Kill → **Disable/Enable** (resident pause, remotely reversible). Server owns the flag, client
  reconciles via hello. No more local re-enable / --enable / --scheduled. This is how you revive the
  VM client: copy the new exe, it comes up paused, click **Enable** on its Client page.
- Block Screen during a Lock says "Locked by a parent — a code won't unlock it" and hides the input.

## Next Windows-VM run (unchanged priorities)
- Enable the paused VM client (see above), then exercise: grant via the calculator, Lock/Unlock,
  End Today, Disable/Enable, self-update (upload on /update), Block Screen vs a fullscreen game
  (including Alt+Tab recovery and on-screen keyboard exemption), multi-monitor, toast top-center. Run
  Install-DigitalAid.ps1 (untested) for the watchdog.
- Still wanted: %ProgramData%\DigitalAid\client.log to close the old "5 minutes" grant mystery.
- Server runs on the dev box; the VM reaches it over the LAN (firewall must allow the port).

## Admin UI rework — BUILT (2026-08-19)

All eight points below are implemented and verified on the dev box with a headless Chrome pass
(`/clients`, `/clients/:id`, `/family-code`, `/settings` in light + dark, phone + desktop). Verified
behaviours, not just "it renders":

- Browser TOTP matches the server: **500/500** random secrets × random times against otplib, and all
  four RFC 6238 vectors. Grant-code arithmetic matches `GrantCode.cs`.
- Trusted Device end to end: wrong password refused, correct password stores the secret, then with the
  **server switched off** the cached page still loads, computes the right code locally, shows the
  offline strip and disables Regenerate.
- Live refresh: grid polls ~2× in 11 s, picks up a server-side change (78 → 99 min) with no reload,
  stops completely while the tab is hidden, and **text typed into the message box survives refreshes**.
- Remember Me: unchecked → session cookie, checked → `Max-Age=2592000`. "Log out all devices" rotates
  the Server Key and invalidates the existing session.

Two defects found and fixed during that pass, both worth remembering: `navigator.onLine` is useless
here (it reports the link, not whether *your* server answers — the Family Code page probes
`/family-code/current` every 15 s instead), and `@fastify/view`'s `layout` option can only *set* a
layout, never disable it, so fragment renders opt out via a `fragment: true` flag read inside
`layout.ejs`.

Still unverified: anything needing HTTPS on a real host, and the phone-installed PWA itself.

### What was decided

Decided in full; nothing here is open. PRD §5 and §7 amended, [ADR-0002](./docs/adr/0002-family-code-secret-in-the-admin-browser.md)
recorded, CONTEXT.md gained **Trusted Device** and **Remember Me**.

**Shape.** Stays server-rendered EJS — an SPA was considered and rejected: four tabs and one detail
page have no routing or state problem, and the look/responsiveness people credit to SPAs is pure CSS.
No build step; every asset self-hosted (a CDN import fails in exactly the offline case the PWA is for).

1. **Liveness by HTML fragments, not JSON.** New fragment routes render the *same* EJS partials the
   full page uses; ~40 lines of vanilla JS swap them in. Avoids a second copy of the timeline-SVG
   rendering in JS. Rule: poll what is *now*, never history — Clients grid ~5s; Client Page on today,
   header ~5s + day card/events ~60s (pings are 1/min, faster is wasted battery); past dates, the logs
   page and /update do not poll. Polls repaint read-only regions only, never a form being typed into.
   Pause on `visibilitychange`. Time Left ticks down locally between polls from a `data-` seed.
2. **Pico.css v2 vendored + ~150-line custom layer.** Existing EJS is already semantic (`<label>`-wrapped
   inputs, real tables/forms), so Update/Password/Setup/Login get their facelift with near-zero template
   edits. The custom layer owns what is actually Digital Aid: Clients grid, status dots, Time Left, code
   display. Deliberate mitigation against looking like a Pico demo: the two screens seen daily (Clients,
   Family Code) are custom; nobody forms an impression from Change Password.
3. **Clients grid** — responsive rounded cards. Dot = connectivity only (green/grey), because a
   *Disabled* Client is online and a green "all good" dot would be a lie about a PC enforcing nothing.
   State rides two other channels: Time Left in the timeline's own colours (`#2e8b57` active / `#2b5cd9`
   grant / `#c0392b` blocked, "quiet until HH:MM" during Downtime), plus a badge only for Disabled /
   Locked / Revoked. Offline → last-known Time Left, dimmed, "as of HH:MM". Sort by name, revoked last,
   never reorder live. Whole card is the tap target.
4. **Family Code tab** — Grant Code first (daily-use): preset chips 10·15·30·45·60·custom, last choice
   remembered locally, one oversized code + copy button + minutes echoed in words. Then the raw 6-digit
   code with its own copy button, Trusted Device, the format explainer (collapsed), Regenerate.
   **Validity is reported truthfully:** both `totp.js` and `Totp.cs` verify ±1 step, so a shown code is
   good ~30–60s — the current "valid for 7s, read it out now" is wrong in the alarming direction. Quiet
   progress ring, not a jumpy number. Copy confirmation carries remaining validity (copy exists for
   sending a code remotely; a clipboard doesn't reach the kid's PC).
5. **Trusted Device** — opt-in on that tab, gated by re-entering the admin password; secret sent once,
   held in IndexedDB, codes computed client-side via WebCrypto **online and offline alike** (an offline
   path only exercised during an outage is only tested during one). Offline is the same screen with a
   strip and Regenerate disabled — not a separate page. Non-trusted + offline → the arithmetic card and
   an invitation to trust the device next time it's online.
6. **Remember Me** — sliding ~30-day persistent session; unchecked keeps today's 12h browser-session
   cookie. Settings gains **Log out all devices** (rotates the Server Key — the only revocation a
   stateless HMAC session has). Password change deliberately does *not* rotate.
   Also fix while in there: `COOKIE_OPTS` in `src/routes/admin.js` has no `secure` flag.
7. **Navigation** — three destinations: Clients · Family Code · Settings (update, password, logout,
   log out all devices). Bottom tab bar on phones, top bar on desktop. Matches the PWA shortcuts the
   PRD already promises.
8. **Service worker** — caches the Family Code tab in full (it holds *no server data*, so the
   "cached authenticated page on a shared phone" objection doesn't apply to it); every other page stays
   uncached as today. The Clients grid does **not** cache last-known state — deliberately deferred.

**Secure-context requirement (decided: degrade loudly, don't work around).** `crypto.subtle` and the
clipboard API are unavailable on insecure origins, so Trusted Device and copy buttons need HTTPS.
A plain `http://<lan-ip>:3000` URL — what the VM uses to reach the dev box — is *not* a secure
context; `localhost` is. Rejected vendoring a JS SHA-1 fallback. Instead the tab detects and says why
it is disabled rather than showing an empty box. **Test these two features against the real TLS
host** (`tailscale serve --bg 3000`), not the LAN IP.


## Field feedback — round 3 (grilled 2026-08-19)

Five items raised after VM testing. Design settled in a grilling session; `CONTEXT.md`,
[ADR-0006](./docs/adr/0006-grant-codes-are-derived-from-a-separate-grant-seed.md) and
[ADR-0007](./docs/adr/0007-a-client-without-a-family-code-secret-enforces-nothing.md) carry the reasoning.

**Renaming the app was considered and dropped** — "Digital Aid" stays. The name is load-bearing in
namespaces, the install path, the global mutex, the Scheduled Task and the DB filename, so it would
cost an uninstall and re-pair for a cosmetic win.

### Built (2026-08-19) — client bugfix pass, 176 tests green

- **Pairing lost after a force-off.** Root cause: `StateStore.Save` renamed a temp file it had never
  flushed, so NTFS kept the directory entry and lost the contents. Now `FileStream` +
  `Flush(flushToDisk: true)` before the move.
- **"The Family Code won't kill it."** Same root cause, not a separate bug — the secret lives in the
  file that vanished. The state it left behind is now named [[Unconfigured]] and defined: no secret
  means no enforcement, no counting, no Block Screen, and exit without a code (ADR-0007). It used to
  enforce `Settings.Default` — a 21:00 Downtime nobody configured — with no way out but uninstalling.
- **Separate no-reuse slots** for Grant and exit codes, so redeeming one no longer spends the other.
- **Re-pairing is gated** on a Family Code when the Client is already set up (ungated when
  Unconfigured). It is the one action that hands the whole policy over at once.
- **`SavePairing` now clears the Event queue** — it reset `NextSeq` to 1 but left events queued under
  the old `client_id`, which would file them against the new Client and eat the numbers it reissues.
- **About dialog**, merged with `--status` rather than added beside it; shows the *running* assembly
  version and flags a mismatch with the recorded one ("did the update land?").
- Fixed: the disabled/unconfigured paths called `HideBlockScreen()` every tick, which logged
  unconditionally — one line per second into `client.log`.

### Built (2026-08-19) — Grant Seed (ADR-0006), protocol 2

Grant Codes are no longer derived from the Family Code. Frozen in [PROTOCOL.md](./PROTOCOL.md) §9:
six digits of `HMAC-SHA256(Grant Seed, "<minutes>:<60s step>")` with the minutes appended in the
clear, verified ±1 step offline. Collecting Grant Codes reveals nothing about the exit key, and
editing the trailing minutes invalidates the code instead of minting time.

- Server generates the **Grant Seed** at setup beside the Family Code secret; existing DBs get one
  backfilled on open (verified in place against the real dev DB, idempotent). Both rotate on the one
  Regenerate button, and go out as `family-code-secret` + `grant-seed` — two messages so a protocol 1
  Client still picks up the TOTP secret it *can* use.
- `hello` carries `grantSeed`; `ClientState.GrantSeed` persists it; `/family-code/trust` hands both
  to a Trusted Device.
- Untrusted browsers are sent *codes*, not keys: `/family-code/current?minutes=N` returns the Grant
  Code as well as the Family Code. The seed never leaves the server for a browser the Admin has not
  deliberately trusted.
- Three implementations pinned to shared vectors. `test/family-code-browser.test.js` lifts the
  derivation out of the *shipped* `public/family-code.js` and runs it against the server's — the
  browser copy is the one nothing imports, so it is the one that would drift unnoticed.
- The PWA now runs two independent countdown rings: the Family Code on TOTP's 30-second step, the
  Grant Code on our 60-second one.
- Grants verify the signature *before* the no-reuse check. The slot holds only the six digits, so a
  code with edited minutes collided with a spent one and was reported "already used" — refused
  either way, but the reason read as a near-miss when the code was never valid.

Verified end to end on the dev box: setup → pair → `hello` carries the seed → server mints a code →
`Client.Core`'s real `EnforcementEngine` grants 25 minutes → replay refused → edited minutes refused.
196 client tests, 54 server tests.

**Consequences now live.** Every pre-existing Grant Code is dead (no back-compat, by decision — the
fallback would be the exact weakness being removed, and it fails open). An authenticator app can no
longer produce a Grant Code: a phone still *exits* a Client with pure TOTP, but extra time comes from
the admin UI or a Trusted Device. The Family Code page's "work it out yourself" instructions are gone,
replaced by an explanation of why there is nothing to work out.

### Next Windows-VM run

1. Re-pair or let the VM Client connect once so it picks up the seed — until it does, it refuses
   every Grant Code (deliberate, ADR-0006).
2. Grant from the admin UI and from a trusted phone browser; check the block screen accepts both.
3. Check the 60-second window really is comfortable when reading a code out loud.
