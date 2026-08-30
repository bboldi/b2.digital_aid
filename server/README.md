# Digital Aid — Server

Self-hosted admin server: settings, usage history, client control. See [../PRD.md](../PRD.md) §5 and
[../PROTOCOL.md](../PROTOCOL.md).

Stack: Node 22 · Fastify · better-sqlite3 · ws · server-rendered EJS · vendored Beer CSS (Material 3).
One process, one SQLite file, **no build step** — `public/vendor/beer.min.css` is copied from the npm
package and committed, because a CDN import would fail in exactly the offline case the PWA exists for.
The design layer on top (theme tokens, status colours, the app shell) lives in `public/style.css`
([ADR-0016](../docs/adr/0016-the-admin-ui-skin-is-beer-css-on-server-rendered-ejs.md)).

```
npm install
npm run dev            # or: npm start   (env: PORT, DB_FILE)
npm run code           # print the current Family Code from the database
```

Default database: `data/digital-aid.db`. First visit walks through setup and shows the Family Code QR
exactly once.

## Deploy behind TLS

Client Tokens and Family Codes travel over this URL, and the admin UI only installs as a PWA from a
secure origin. Any TLS front end works; with Tailscale it is one command on the server:

```
sudo tailscale serve --bg 3000      # https://<host>.<tailnet>.ts.net -> localhost:3000
```

## PWA

The admin UI installs on a phone (manifest, icons, service worker, shortcuts to Family Code and
Clients). The service worker caches the static shell, an offline page, and `/family-code` — nothing
else, because every other page shows live state and cached authenticated pages would linger on a
shared device. `/family-code` is safe to cache precisely because it renders no server data: its codes
are filled in by `public/family-code.js`, either from the server or, on a **Trusted Device**, from a
secret held in that browser's IndexedDB (PRD §5.4, ADR-0002).

## Liveness

Pages that show *now* refresh themselves by re-fetching server-rendered fragments and swapping them
in — `public/live.js`, driven by `data-live-src` / `data-live-every` attributes. The fragments render
the same EJS partials (`views/partials/`) the full page does, so there is never a second copy of the
markup in JavaScript. Rules that matter:

- Only read-only regions carry `data-live-src`. A form the Admin may be typing into is never replaced.
- History does not poll: past dates, the logs page and `/settings` are left alone.
- Polling stops entirely while the tab is hidden and catches up when it returns.

## Secure context required

`crypto.subtle` and the clipboard API are unavailable on insecure origins, so **Trusted Device and
the copy buttons need HTTPS** (`localhost` also counts). On a plain LAN address like
`http://192.168.0.25:3000` the page says so rather than presenting buttons that quietly do nothing.
Test those two features against the real TLS host.

## About

Part of [Digital Aid](../README.md). Made by Boldizsár Bednárik · [bboldi.com](https://bboldi.com) ·
[bbednarik+digitalaid@gmail.com](mailto:bbednarik+digitalaid@gmail.com) · [MIT](../LICENSE).

Versioning: `./publish.sh` bumps `package.json`, commits and tags `server-vX.Y.Z`. The tag is the
release — there is no artifact. The running version is shown in Settings → About, and says `+dev`
when the tree is not the tag it claims to be. The server does not update itself: `git pull &&
npm install`, then restart ([ADR-0011](../docs/adr/0011-the-server-does-not-auto-update.md)).
