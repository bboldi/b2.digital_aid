# Digital Aid — Client

Windows client: enforces Allowance/Downtime/Grants, Block Screen, Flyout, offline-first. See [../PRD.md](../PRD.md) §6 and [../PROTOCOL.md](../PROTOCOL.md).

Stack: .NET 10 (LTS) / C#.

- **`Client.Core`** (`net10.0`, no Windows deps) — all the rules: `EnforcementEngine` (Grant > Downtime >
  Allowance, monotonic accrual, midnight flip, warnings), `Totp`, `GrantCode`, `StateStore`,
  `EventQueue`, `RunMarker`, protocol DTOs, and `ClientAgent` which wires them together.
- **`Client.App`** (`net10.0-windows`, WPF) — the shell only: tray icon, Block Screen (all monitors,
  topmost, re-asserted), non-activating toasts, pairing/exit dialogs, Flyout, WebSocket link, and the
  Win32/session-event plumbing. It performs what `ClientAgent` decides and holds no rules of its own.

## Build and test (works on Linux)

```
dotnet test                    # 139 tests — all of Client.Core
./build.sh [out]               # fast: no tests, no version bump, stamped +dev.<sha>
./publish.sh patch|minor|major # release: tests, bumps VERSION, publishes, commits, tags, GitHub Release
./publish.sh 0.4.0             # ... or set the version explicitly
```

WPF cross-compiles from Linux via `EnableWindowsTargeting`; the shell itself can only *run* on Windows.

## Versioning

`client/VERSION` is the single source of truth. `Directory.Build.props` reads it into `<Version>`, so
the tag, the exe, the Ping and the admin UI all quote the same number — there is no version to type
anywhere.

`build.sh` never bumps it. Every build it produces is stamped `<VERSION>+dev.<git-sha>` (plus
`.dirty` for uncommitted work) in `InformationalVersion`, and **the server refuses to accept a build
carrying that suffix**. That is the whole point of the suffix: a scratch build cannot reach a kid's
PC, and a Client reporting one on the Client Page is visibly not a release.

`publish.sh` refuses to run on a dirty tree, then bumps `VERSION`, commits, tags `vX.Y.Z`, pushes,
and creates the GitHub Release with the exe and its checksum attached (ADR-0018) — that Release is
where a new family's first exe comes from.
Without the tag a version is a label with no anchor: build `0.2.0`, tweak a file, build again, and
two different exes both claim it — and since Clients update on SHA-256, *both* would install, leaving
the version column lying to the parent about what is running.

`publish.sh --test` (or `--ignore-commit`) is the middle path, for when the only way to check a
change is to install it on the test VM. It skips the dirty check, the bump, the commit and the tag,
and stamps `<VERSION>-test.<fingerprint>` — a prerelease tag (`-`) rather than build metadata (`+`),
so **the server accepts it**, which is the point. The fingerprint covers HEAD plus every uncommitted
and untracked change, so two different trees can never carry the same label; the invariant the commit
was protecting is kept by other means rather than dropped. `VERSION` is untouched, so it keeps
pointing at the last thing actually tagged. Install the real release afterwards and the test machine
updates back to it on the next hash mismatch, like any other client.

To roll back, upload the older exe again. Clients update on hash mismatch rather than version order,
so an older build announced later is simply installed.

## The exe

Framework-dependent single file, ~270 KB. Self-contained would be ~166 MB, and since self-update
pushes this file to every kid's PC (PRD §6.7), small wins. The cost is a one-time prerequisite per
machine, installed by the parent alongside the client:

```
winget install Microsoft.DotNet.DesktopRuntime.10
```

The installer offers to run that itself when it finds no runtime — but do not count on it: the `.bat`
elevates, so on the kid's standard account it runs as the *parent's* account, and `winget` is a
per-user package that may never have been provisioned there.

## Install on a kid's PC

The ordinary way is the **Install Kit**: open the server's `/download` page in a browser on that
machine — no login, it is linked from the login page — and download the zip. It holds this exe and
these scripts, flat, in one folder. Unzip and double-click `Install-DigitalAid.bat`; it elevates
itself and runs the PowerShell below. ADR-0015 covers why that page has no password on it.

From a checkout instead, in an elevated PowerShell (once):

```
powershell -ExecutionPolicy Bypass -File .\install\Install-DigitalAid.ps1
```

The script looks for `DigitalAid.exe` beside itself first (the kit's flat layout), then in
`..\dist\` (a checkout after `publish.sh`), so both work with no arguments.

Copies the exe to `%ProgramData%\DigitalAid`, grants Users write access there (self-update replaces
the exe in place), and registers the Scheduled Task that starts the app at logon and re-runs it every
minute if it is not running. The kid's Windows account must be a **standard user** — that is what
prevents clock changes and task deletion.

`Uninstall-DigitalAid.ps1` reverses it; add `-Purge` to also wipe local state (otherwise a reinstall
resumes as the same Client rather than creating a duplicate).

Handy on a client machine:

```
DigitalAid.exe --status    # paired server, disabled flag, today's counters, queued events
DigitalAid.exe --enable    # undo a remote kill
```

## Local state

`%ProgramData%\DigitalAid\state\` — `state.json` (token, `next_seq`, cached settings, counters),
`events.jsonl` (offline Event queue), `running` (marker behind unclean-exit inference). Machine-wide
and app-writable, because self-update replaces the exe in place.

## About

Part of [Digital Aid](../README.md). Made by Boldizsár Bednárik · [bboldi.com](https://bboldi.com) ·
[bbednarik+digitalaid@gmail.com](mailto:bbednarik+digitalaid@gmail.com) · [MIT](../LICENSE).
