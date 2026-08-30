# The Install Kit downloads without a login

Putting the client app on a new PC had no supported path. `GET /api/update/latest` authenticates with an `x-client-token` header — the credential issued at [[Pairing]] — so the endpoint that holds every build is reachable only by machines that are already on the fleet. A PC that has never been paired cannot fetch the thing that would let it pair. The exe travelled by USB stick, shared folder, or whatever was to hand, and the install scripts never travelled at all: they live in `client/install/` and were only ever run from a checkout.

The [[Install Kit]] closes that, and it downloads from `/download` **without a login**.

That is the surprising half, because this system has exactly one adversary and they live in the house. An unauthenticated page hands anyone who reaches the server a copy of the precise binary running on the kids' machines, plus scripts that spell out the ProgramData layout, the Scheduled Task name, and the every-minute watchdog. For a kid who wants to understand what is blocking them, that is a shortcut.

It was taken anyway, for two reasons. The first is the workflow: installing happens *at the kid's PC*, in their browser, with the kid standing there. A login means typing the household's admin password on the machine of the one person it defends against, and a password shoulder-surfed once is worth far more than a binary. The second is that the disclosure is already public — the repository is open, and README.md, PRD.md and PROTOCOL.md describe the watchdog, the layout and the wire protocol in more detail than the scripts do. The kit reveals nothing a search would not.

The middle roads were both rejected as costing the parent more than they cost the kid. A secret bookmarkable URL is a secret to look up on a phone before every install, and once found it is found forever. A rate limit on the zip does not slow a curious kid down at all, and does lock out a parent re-trying a failed install at 9pm.

The guiding principle applies here as everywhere: **visibility over enforcement**. Hiding the binary was never going to stop anything, and pretending otherwise would have bought a worse workflow with no security.

## Consequences

The page carries the latest build only. Not a menu of versions — an older one would self-update within a minute of [[Pairing]] anyway, so the choice undoes itself, and a build history is exactly the reconnaissance the decision otherwise minimises. It carries no [[Client]] names, no server version, and no hashes: the version number, the button, and three lines of what to do next. `noindex` and a `robots.txt` disallow keep an unsigned executable on a private domain out of search indexes and scanner corpora.

The zip is built per request from the latest announced row plus `client/install/` read off the deployed checkout — the scripts are server-repo artifacts, updated by the same `git pull` as the server ([ADR-0011](./0011-the-server-does-not-auto-update.md)), so a committed second copy under `server/` would only drift. If that directory is absent, the page says so rather than serving a kit with no installer in it. Nothing is prebuilt, because a prebuilt kit would freeze scripts that change underneath it.

The kit arrives through a browser, which is new, and a browser attaches Mark of the Web. `Copy-Item` preserves alternate data streams, so an extracted exe copied into ProgramData would carry its zone marker into a Scheduled Task that launches it every minute, unattended. The installer therefore calls `Unblock-File` on what it installs. Self-update is untouched by this — the client fetches over HTTP with no browser in the path, so no zone is ever attached, and this is an Install Kit problem alone.

Because the parent is now installing somewhere the runtime may be missing, the installer offers to run `winget install Microsoft.DotNet.DesktopRuntime.10` itself rather than printing it as homework. It is offered, not assumed: the `.bat` elevates, so on a kid's standard account the elevated session runs as the *parent's* account, and winget is a per-user package that may never have been provisioned there. The page states the prerequisite too, for exactly that case.
