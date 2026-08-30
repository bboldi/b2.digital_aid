# Contributing

Digital Aid is a personal project, built for one household and published because the shape of it
might fit yours. It is maintained in the gaps of family life — issues are welcome, pull requests are
read, and neither comes with a promised response time.

**Bug reports** are the most valuable thing you can send. Include the server and client versions
(both are on the admin page's About section), what you expected, and what happened. Logs beat
adjectives.

**Pull requests** are welcome for bugs, translations, and improvements that fit what the project
already is. Before building a feature, open an issue first — it may already have been considered and
deliberately rejected, and [docs/adr/](./docs/adr) is the record of those decisions. Read
[CONTEXT.md](./CONTEXT.md) and use its words; both halves have test suites (`npm test`,
`dotnet test`) and a PR is expected to keep them green.

**The philosophy is not up for negotiation.** Visibility over enforcement; no covert surveillance;
everything recorded about the kid is shown to the kid. Features that strengthen the parent's hand by
weakening the kid's knowledge of it — screenshots, content logging, stealth modes, tamper-proofing —
will be declined regardless of how well they are built. There is plenty of software like that
already; this is deliberately not it.

Security issues: see [SECURITY.md](./SECURITY.md) — please don't open public issues for those.
