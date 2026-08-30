# 0016 — The admin UI skin is Beer CSS (Material 3) on server-rendered EJS

**Status**: accepted, 2026-08-21

## Context

The admin UI was restyled twice and both attempts disappointed: a Pico-based rework (2026-08-19,
kept but never loved) and a hand-rolled design-token layer replacing Pico (2026-08-20, rejected on
sight and hard-reset; its ADR-0016 died with it — this document reuses the number). The admin asked
for a UI that reads as a native mobile app — the PWA lives on an Android phone — and raised the
Ionic family of frameworks as the way to get there.

Ionic, Quasar, Framework7 and their kin assume they own rendering: a build step, a client-side
router, the server demoted to a JSON API. This server's architecture is deliberately the opposite —
server-rendered EJS, fragment refresh (`public/live.js`), i18n resolved per request, a service
worker whose caching story depends on pages being server state, and **no build step** because every
asset must be self-hostable for exactly the offline case the PWA exists for.

## Decision

Keep server-side rendering untouched and change only the skin:

- **Beer CSS** (Material 3, ~86 KB minified) replaces Pico, vendored the same way at
  `public/vendor/beer.min.css`. No build step, no icon font — the app keeps its inline stroke SVGs.
- The design layer in `public/style.css` owns the theme: Material tokens seeded from the product's
  grant-blue `#2b5cd9`, the `--da-*` status vocabulary carried over, dark mode riding
  `prefers-color-scheme` with no picker and no JavaScript.
- The original taste anchor was **Google Family Link**. The production direction selected after the
  next prototype round is **Status Bento**: compact live summaries, one dark status surface, modular
  evidence tiles, and denser responsive grids. Cards are reserved for information modules rather
  than used as the universal shape for every settings section. Four bottom tabs remain a rail on
  desktop, and each Client card still carries the shape of the day so far — visibility over
  enforcement, on the card itself.
- Process guard, learned the hard way: the look was approved from throwaway static mockups
  screenshotted at phone width in light and dark **before** any real view changed.

The Status Bento update followed that guard: three interactive directions — Refined Material, Warm
Editorial and Status Bento — were compared across Clients, Client Page and Settings in light/dark
phone and desktop layouts before Status Bento was chosen.

## Consequences

- Beer is class-based where Pico was classless, so the swap touched every view once. Beer also
  claims generic names the app used (`.badge`, `.row`, `.tabs`, `.page`, `.chip`, `.small`); ours
  were renamed (`.tag`, `.inline-row`, `.seg-tabs`) rather than fought over specificity.
- Beer expects to own the app shell (`body:has(>main)` becomes its layout grid) and hides bare
  file inputs and SVG fills; `style.css` opts back out of each. Future Beer upgrades must be
  checked against these opt-outs.
- The SPA door stays closed: any future "native feel" work happens inside the SSR + fragments
  model, or it reopens this ADR.
- Status Bento widens the desktop content area and lets utility modules form responsive grids, but
  phone remains the primary control surface. Dense evidence tables stay tables on desktop and turn
  into labelled rows on phones; live status and forms retain their existing server ownership.
