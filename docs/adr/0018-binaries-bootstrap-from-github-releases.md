# Binaries bootstrap from GitHub Releases; the family server is the only update channel

Going open source poses a distribution question the architecture had already answered for everyone
except one person: the parent, on day one. Kid PCs get their exe from the family's own server — the
[[Install Kit]] zips it with the install scripts, and a running [[Client]] self-updates over the
WebSocket by hash. But a fresh clone contains no exe at all (`client/dist/` is ignored, on purpose),
and the server's `/download` page has nothing to offer until someone uploads a build on `/settings`.
The first exe has to come from somewhere.

Three ways considered:

- **Commit the exe to the repository.** Works, and was the first instinct. Rejected because every
  release would embed the full binary in history forever, the repo would grow without bound, and a
  binary in a source tree is the one file nobody can review.
- **Source only.** Require a Windows-targeting `dotnet publish` from anyone who wants to try it.
  Honest, but it gates a family tool behind a .NET SDK, and the audience is technical *parents*, not
  necessarily .NET developers.
- **GitHub Releases.** The release tag the publish script already creates gets a Release object with
  the bare `DigitalAid.exe` and its checksum attached as assets — stored on GitHub's CDN, outside git
  history. Chosen.

The Release is strictly a **bootstrap**: one hop, from GitHub to the parent's hands, so they can
upload it to their own server. It is not an update channel and must not become one — the same
reasoning that keeps the server from auto-updating ([ADR-0011](./0011-the-server-does-not-auto-update.md))
applies doubled to an exe that runs on every kid's PC. No kid's machine ever talks to GitHub; the
[[Client]] takes updates only from the family server that paired it, and the wire protocol carries
only `{version, sha256, path}` — no GitHub URL exists anywhere in the running system.

The binaries are **unsigned**. A code-signing certificate costs real money annually for a project
whose whole client is a couple hundred kilobytes of framework-dependent IL, and the audience that
distrusts an unsigned exe is exactly the audience equipped to build from source — which stays the
documented alternative. The README says plainly what SmartScreen will do and why, which earns more
trust than a certificate bought to silence it.

## Consequences

`client/publish.sh` grows one final step: push the tag and `gh release create` with `DigitalAid.exe`
and a `SHA256SUMS.txt`. A release that exists as a local tag but not on GitHub is a half-released
state, so the step is automatic, not a flag — and skipped for `--test` builds, which are not releases
and never leave the household.

Only client tags (`vX.Y.Z`) get Releases. Server tags (`server-vX.Y.Z`) do not, because a server
release has no artifact — updating a server is `git pull` by decision, and a Release object would
just break the invariant that `releases/latest/download/DigitalAid.exe` always resolves to a client
binary.

The upload form on `/settings` is the trust boundary, exactly as before: the server reads the version
out of the PE header, stores the file content-addressed, and refuses `+dev` builds. Where the parent
got the exe — GitHub, their own build, a USB stick — the server neither knows nor cares. The sha256
printed by the publish script, shown on the Release page, and displayed by the server after upload is
the same number three times, and checking it is the verification story.
