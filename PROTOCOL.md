# Digital Aid — Wire Protocol

**Protocol version 4.** This document is the authority for the version number; bump it here when a shape changes incompatibly.

Version 4 added Time Coupons (`coupon` §5.4, `coupon-status` §6.10, the `coupon-redeemed` Event). Additive both ways: a version 3 Client never sends `coupon` and cannot redeem one until it updates — its parser rejects letters — and a version 3 server answers `coupon` with nothing, which the Client reports as unreachable-for-coupons. Nothing else changes shape.

Version 3 added Block Screen Backgrounds (`backgrounds` in `hello`, the `background` message and `GET /api/background/:slot`, §6.9) and machine-id pairing (`machineId` and `adopt` on `POST /api/pair`, §3). Every addition is optional in both directions: a version 2 Client sends no `machineId` and pairs as it always did, ignores the background fields and shows a plain cover, and drops the `background` message as an unknown type. A version 3 Client against a version 2 server gets no backgrounds and pairs as a stranger. Nothing in either combination misbehaves — the feature is simply absent, which is what the version badge in the admin UI is for.

Version 2 added the [[Grant Seed]] (`grantSeed` in `hello`, §6.6a) and changed how a Grant Code is derived (§10). A version 1 Client talks to a version 2 server perfectly well — it simply ignores the seed, and its Grant Codes stop being accepted, which is the intended and unavoidable consequence of ADR-0006.

Frozen message shapes between a **Client** and the server. Terms are from [CONTEXT.md](./CONTEXT.md); behaviour is specified in [PRD.md](./PRD.md) §7. Where this document and the PRD disagree about a *shape*, this document wins; where they disagree about *behaviour*, the PRD wins.

Each message is marked **implemented** (server code exists) or **planned** (shape frozen here, not yet emitted or handled).

## 1. Conventions

- All payloads are JSON objects with a `type` discriminator (lowercase, hyphenated).
- Unknown fields are ignored by both sides. Unknown `type` values are logged and ignored, never fatal — this is what lets an older Client talk to a newer server after a self-update.
- Absent and `null` are equivalent. Omit rather than send `null`.
- Minutes are always whole numbers. Never send fractional minutes.
- The server never arbitrates time (PRD §3). No message carries a server clock reading for the Client to adopt.
- **A protocol version mismatch is logged and surfaced, never fatal.** Both sides keep talking, and the mismatch is badged in the admin UI. Refusing the connection would blind the audit trail exactly when something is wrong, and a Client that cannot report is a Client the parent cannot see.

### Timestamps

| Direction | Format | Example |
|---|---|---|
| Client → server (`ts`) | ISO 8601 **with UTC offset** | `2026-08-18T20:40:11+02:00` |
| Server-side stamps (`ts`, `received_at`) | SQLite `datetime('now')`, UTC, no offset | `2026-08-18 18:40:12` |

The offset is mandatory on client timestamps: Allowance and Downtime are local-time concepts, and a bare timestamp loses the only thing that makes a clock-jump Event legible after the fact. The server stores the string verbatim and stamps its own arrival time separately — the two clocks are deliberately kept distinguishable (PRD §6.5).

## 2. Transport

- **Pairing:** one HTTPS `POST`. No session, no cookie.
- **Everything else:** one WebSocket per Client, `GET /ws`.
- **Update download:** one authenticated HTTPS `GET`, §6.7.
- Deploy behind TLS. Client Tokens and Family Code secrets travel over this connection in the clear at the application layer.
- **Liveness** is WebSocket-level ping/pong frames (RFC 6455), handled by the `ws` library — not an application message. Being connected *is* being online. The minutely `ping` message is a usage report, not a liveness probe.
- **Reconnect** is the Client's job, on two ladders — see [ADR-0009](./docs/adr/0009-two-reconnect-ladders-unreachable-and-rejected.md). *Unreachable* (no response) climbs 5/10/20/30 s, jittered, capped at **60 s**. *Rejected* (`4001`) uses its own ladder capped at **30 min**: the server is up and has said no, and there is no un-revoke, so retrying fast is pointless — the slow retry exists only so a `4001` caused by a restored backup or a bad deploy heals itself. There is no server-side reconnect signal. Either ladder is abandoned immediately when Windows reports the network returning or the machine resuming from sleep. The backoff only resets after a connection has *survived* ~30 s — a `4001` close arrives after the handshake succeeds, so treating "connected" as success would let a revoked Client retry every 5 s forever.
- **Server origin.** The Client resolves every server path against the base URL it paired with. The server sits behind a reverse proxy and does not reliably know its own public origin, so it never constructs absolute URLs.

## 3. Pairing — `POST /api/pair` · implemented

The only unauthenticated endpoint. Creates a new Client row, **unless** the machine is one the server already knows, in which case it offers that Client back first — see [ADR-0008](./docs/adr/0008-pairing-may-adopt-an-existing-client-by-machine-id.md).

**Request** — `Content-Type: application/json`

```json
{ "code": "492817", "name": "KIDS-PC", "protocol": 3, "machineId": "9f1c…" }
```

| Field | Type | Notes |
|---|---|---|
| `code` | string | Current 6-digit Admin Code. Verified server-side against the household TOTP secret, ±1 step of skew. |
| `name` | string | PC name; becomes the Client display name, renamable later. Blank or missing becomes `"Unnamed PC"`. |
| `protocol` | int \| absent | Protocol generation the Client speaks. Recorded, never enforced. Absent means pre-versioning and is recorded as unknown. |
| `machineId` | string \| absent | Stable per-machine id (Windows `MachineGuid`). **Not a credential** — it only proposes *which* Client the code applies to, and is never sufficient on its own. Absent is fully supported and behaves exactly as pairing did before this field existed. |
| `adopt` | int \| `false` \| absent | Absent on the first call. On the second: the `clientId` a person agreed to reconnect to, or `false` for "set this up as a new PC". |

**Responses**

| Status | Body | Meaning |
|---|---|---|
| `200` | `{ "match": { "clientId": 3, "name": "Kid PC", "lastSeen": "2026-08-17 21:14:02" } }` | This machine is already known. **No token is issued.** Ask a person, then call again with `adopt`. |
| `200` | `{ "clientId": 3, "token": "<64 hex chars>", "protocol": 3 }` | Paired as a new Client. A settings row is created with the defaults in §7.3. |
| `200` | `{ "clientId": 3, "token": "<64 hex chars>", "protocol": 3, "adopted": true }` | Reconnected to an existing Client. Its history, settings and name are untouched; the new token replaces the old one, which stops working. |
| `401` | `{ "error": "invalid code" }` | Code wrong or outside the skew window. |
| `409` | `{ "error": "no longer available" }` | The `adopt` target is not a live Client carrying this `machineId` — deleted or revoked in between, or never the caller's to claim. |
| `503` | `{ "error": "server not set up" }` | First-run setup has not happened yet, **or** it was never finished — the Admin Code is still provisional and verifies nothing ([ADR-0010](./docs/adr/0010-a-new-admin-code-is-provisional-until-someone-proves-it.md)). |

The exchange is **stateless**: the second call carries its own `code`, nothing is remembered between the two, and an abandoned prompt leaves no trace. A Client is offered back only if it is not revoked — revoking is a deliberate "this machine is done with", and handing it straight back would undo it.

`adopted: true` matters to the Client beyond bookkeeping: it means the identity is *not* new, so the Client must **keep** its event sequence rather than restarting at 1, and must **not** discard its queued Events. Restarting the sequence would reissue numbers the server already holds, and §5.2 dedupes on `(client, seq)` by ignoring collisions — so those Events would be dropped in silence.

The `token` is the **Client Token** — permanent, returned exactly once, stored hashed (SHA-256) server-side. The Client must persist it before reporting success to the user.

Pairing returns no settings. The Client gets them from `hello` on its first WebSocket connect.

## 4. WebSocket connect — `GET /ws` · implemented

Authentication is a header:

```
x-client-token: <the Client Token from pairing>
```

**Never put the token in the URL.** Query strings land in access logs, proxy logs, and `Referer` headers; the token is permanent, so a leak is not recoverable by expiry.

| Outcome | Behaviour |
|---|---|
| Valid token, not revoked | Connection accepted; server immediately sends `hello`. |
| Missing, malformed, unknown, or **revoked** token | Close code `4001`, reason `unauthorized`. |

Only one socket per Client is tracked. A second connection with the same token replaces the first in the hub; the displaced socket is not closed by the server, so a Client must not hold two connections open — it would silently stop receiving commands on one of them.

**On `4001` the Client keeps enforcing its last-known settings and keeps retrying on the rejected ladder (§4, ~30 min).** Revoke is not remote uninstall (PRD §5.3) and not a stop signal — the Client goes standalone, not dormant. It does, however, stop looking like a network fault: a rejected Client shows its own state in the tray and the Flyout, pointing at re-Pairing, which is the only way back.

## 5. Client → server

### 5.1 `ping` · implemented

Once per minute, always, whether or not anything changed. This is the parent audit trail; gaps are meaningful data (PRD §6.5), so an unchanged minute still gets a row.

```json
{
  "type": "ping",
  "status": "active",
  "remaining": 47,
  "app": "Minecraft",
  "version": "0.1.0",
  "protocol": 1,
  "reason": "allowance"
}
```

| Field | Type | Notes |
|---|---|---|
| `status` | string | See §7.1. **Stored verbatim**, including unrecognised values. |
| `remaining` | int \| absent | Remaining Allowance minutes today. May be `0`; absent means unknown, not zero. |
| `app` | string \| absent | Foreground App product/exe name only. Never window titles, URLs, or process lists (PRD §6.3). Absent when nothing is in the foreground (locked, blocked). |
| `version` | string \| absent | Client app version. Absent **keeps the previously recorded version** rather than clearing it. |
| `protocol` | int \| absent | Protocol generation, reported every minute because self-update can change it without re-pairing. Absent keeps the previous value. |
| `reason` | string | Time Left kind: `grant` / `allowance` / `downtime` / `exhausted` / `locked`. Lets the server show *why* a Client is blocked and drive the Lock toggle (PRD §3.1). |

Pings are not queued while offline the way Events are — a missed minute is a gap in the timeline, and that is the intended representation. Do not backfill pings on reconnect.

### 5.2 `events` · implemented

A batch of Events, including the offline backlog. Inserted in a single transaction — a batch lands whole or not at all.

```json
{
  "type": "events",
  "events": [
    { "seq": 41, "ts": "2026-08-18T20:40:11+02:00", "type": "grant-redeemed", "payload": { "minutes": 25 } },
    { "seq": 42, "ts": "2026-08-18T21:05:03+02:00", "type": "unclean-exit" }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `events` | array | Required. A non-array is dropped without error. Order should be chronological; the server does not sort. |
| `events[].seq` | int | **Per-Client monotonic sequence number**, starting at 1, persisted by the Client alongside its counter state. See §8. |
| `events[].ts` | string | Client local time, §1. Stored verbatim. |
| `events[].type` | string | See §7.2. Unrecognised types are stored as-is, so an unknown type from a newer Client is preserved rather than discarded; a missing type becomes `"unknown"`. |
| `events[].payload` | object \| absent | Serialised to a JSON string server-side. Shape is per event type. |

Delivery is idempotent: re-sending a batch is free. There is no acknowledgement — see §8.

### 5.3 `request` · implemented

The kid asking a parent for more time (CONTEXT.md: Request) — the only kid→parent message in this protocol, and the only client→server message that gets an answer.

```json
{ "type": "request", "minutes": 30 }
```

| Field | Type | Notes |
|---|---|---|
| `minutes` | int | How much is being asked for. Clamped server-side to 1–180. **Advisory** — the Admin picks the real number when approving. |

Carries minutes and nothing else: no reason, no message, no free text. That is what keeps the "never content" promise intact, and keeps "ask for more time" from becoming "justify yourself".

Answered immediately with a `request-status` (§6.8) carrying `pending`, `duplicate` or `cooldown`. The verdict, when a parent gives one, arrives as a second `request-status` — possibly minutes later, possibly on the next connection.

Deliberately **not** an Event: a Request is a live ask, and one delivered from an offline backlog an hour later answers a question nobody is still asking. The Client sends it only while connected and tells the kid if it could not. The *fact* that an ask was made is logged separately, as a `time-requested` Event (§7.2).

### 5.4 `coupon` · implemented

Sent when a code containing letters is typed into the code entry — the Client dispatches on shape, so this and a Grant Code share one box (ADR-0017).

```json
{ "type": "coupon", "code": "KRTVXM030" }
```

| Field | Type | Notes |
|---|---|---|
| `code` | string | The canonical uppercase, separator-free 9-character form. The Client uppercases and strips separators before sending. |

The Client refuses locally during Downtime *before* sending (ADR-0017), so the server never sees that case. Answered inline with `coupon-status` (§6.10). Live-only — there is no queueing: a coupon typed while offline is refused with "try again later" and stays unspent.

## 6. Server → client

All server→client commands are **live-only**: nothing is queued for an offline Client. A command sent to an offline Client is dropped and the admin UI says so (PRD §6.4). The one exception is a Request verdict (§6.8), which is held briefly because it is the answer to a question the kid asked rather than a standing intent the Admin can simply re-issue — see ADR-0005.

### 6.1 `hello` · implemented

Sent unprompted, immediately on every successful connect. Not a response to anything.

```json
{
  "type": "hello",
  "protocol": 2,
  "lastSeq": 42,
  "settings": { "client_id": 3, "downtime_start": "21:00", "downtime_end": "07:00",
                "weekday_minutes": 120, "weekend_minutes": 180 },
  "familyCodeSecret": "JBSWY3DPEHPK3PXP",
  "grantSeed": "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0",
  "backgrounds": {
    "blocked": { "hash": "9f8c…", "path": "/api/background/blocked" },
    "downtime": null
  }
}
```

| Field | Notes |
|---|---|
| `protocol` | The server's protocol generation. A Client that disagrees logs it and carries on. |
| `lastSeq` | Highest Event `seq` the server holds for this Client, or `0` if none. The Client **resumes above this value** — see §8. |
| `settings` | Current settings, §7.3. |
| `familyCodeSecret` | Current household TOTP secret — verifies exit codes and pairing. |
| `grantSeed` | Current Grant Seed, 32 bytes as 64 lowercase hex chars — verifies Grant Codes (§10). Absent from a version 1 server; a Client without one refuses all Grant Codes rather than falling back. |
| `update` | Latest build offer `{version, sha256, path}`, or absent if none. The Client compares `sha256` to its own exe (PRD §6.7). |
| `disabled` | Whether the Admin has paused this Client (PRD §5.3). The Client reconciles its local flag to this on every connect. |
| `backgrounds` | The two Block Screen Backgrounds, **already resolved** for this Client — see §6.9. Absent from an older server, which the Client reads as "no pictures". |

Carries the current settings and **both** household secrets on every connect. This is the rotation mechanism: a Client that was offline through a regeneration picks up the new pair here, and honours the old pair until it does (PRD §4).

The Client persists both, obfuscated at rest (DPAPI), and treats them as its enforcement truth until the next `hello` or `settings`.

### 6.9 `background` · implemented

Sent when a Block Screen Background changes: to one Client when its own override changes, and to every Client when a household picture does. The payload is identical to `hello`'s `backgrounds` field, so a Client reconnecting and a Client being told live take the same path.

```json
{
  "type": "background",
  "backgrounds": {
    "blocked": { "hash": "9f8c…", "path": "/api/background/blocked" },
    "downtime": { "hash": "1a2b…", "path": "/api/background/downtime" }
  }
}
```

Each slot is a `{hash, path}` pair or `null`. **Null means show nothing there** — the Client deletes any file it holds for that slot, so removing a picture on the server actually removes it from the cover rather than leaving the last one in place.

The server resolves which picture applies (this Client's override, else the household's) before sending, so the Client never learns the difference and never needs to. The two slots resolve **independently**: a Client can be sent its own night-time picture alongside the household's out-of-time one.

`path` is fetched over HTTP with the same header auth as `/ws` and `/api/update/latest`:

```
GET /api/background/blocked
x-client-token: <the Client Token>
```

Answering `200` with the image bytes, `image/jpeg` or `image/png`, and the content hash in `x-background-sha256`. `404` means the slot resolves to nothing; `401` means the token is not accepted.

Bytes deliberately do **not** travel down the socket. The Block Screen appears at precisely the moments the server is unreachable — an exhausted allowance and a dead server tend to arrive together — so the image has to already be on the Client's disk. It downloads only when the hash differs from what it holds, and every failure on this path (not configured, not yet downloaded, half-written, corrupt, undecodable) resolves to a plain cover with nothing reported on screen.

Only JPEG and PNG are accepted at upload, checked by magic bytes rather than by filename, because the Client draws these with WPF and WPF has no decoder for WebP or HEIC. Uploads are capped at 8 MB; the server does no resizing, so whatever is uploaded is what every Client downloads and decodes.

### 6.2 `settings` · implemented

Pushed when the Admin saves settings on the Client Page.

```json
{ "type": "settings",
  "settings": { "client_id": 3, "downtime_start": "21:00", "downtime_end": "07:00",
                "weekday_minutes": 120, "weekend_minutes": 180 } }
```

Same `settings` object as `hello`. It is a full replacement, not a patch.

### 6.3 `message` · implemented

```json
{ "type": "message", "text": "Dinner in 10 minutes" }
```

Displayed as a topmost, **non-activating** toast — never steals focus from a game. Dismiss only, no reply. The Client logs a `message-shown` Event.

### 6.4 `adjust` · implemented

```json
{ "type": "adjust", "minutes": 30 }
```

A non-zero integer, positive or negative. Positive behaves exactly like a Grant (§7.2). Negative subtracts from remaining time; if it empties it, the Client warns ~1 minute before showing the Block Screen (PRD §6.2). The Client logs an `adjustment-applied` Event.

### 6.4a `lock` / `unlock` · implemented

```json
{ "type": "lock" }
```

An immediate held block that beats everything, including an active Grant (PRD §3.2). `unlock` releases
it; the Client also auto-releases at local midnight. The Admin button toggles based on the Client's
reported `reason` (see §5.1), so it reflects reality even after an auto-release.

### 6.4b `end-today` · implemented

```json
{ "type": "end-today" }
```

Drains the rest of today's Time Left (exhausts Allowance, clears any Grant) so the Client blocks now.
Recoverable: a fresh Grant still gives time back; tomorrow's Allowance is untouched.

### 6.5 `disable` / `enable` · implemented

```json
{ "type": "disable" }
```

A resident **pause**, remotely reversible (PRD §5.3). On `disable` the Client stops enforcing and counting but stays running and connected; on `enable` it resumes. Each logs a `disabled` / `enabled` Event. The server owns the flag and echoes it in `hello` (`disabled: bool`), so a Client reconciles to it on reconnect even if it missed the live command. There is no hard "kill".

### 6.6 `family-code-secret` · implemented

```json
{ "type": "family-code-secret", "secret": "NB2W45DFOIZA" }
```

Broadcast to every connected Client when the Admin regenerates the household secrets. Replaces the stored secret immediately. Offline Clients get it via `hello` on next connect.

### 6.6a `grant-seed` · implemented

```json
{ "type": "grant-seed", "seed": "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0" }
```

The Grant Seed half of the same rotation. The two secrets always change together, but they travel as two messages rather than one: a version 1 Client ignores this type and still picks up the new TOTP secret from §6.6, so a rotation never leaves an old Client unable to exit. A message with a missing or empty `seed` is ignored — blanking the stored seed would silently disable Grants.

### 6.7 `update` · planned

Announced on connect and when the Admin uploads a new build (PRD §6.7). The server-side upload routes are parked (TODO.md); the shape is frozen here so `Client.Core` can be written against it.

```json
{
  "type": "update",
  "version": "0.2.0",
  "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "path": "/api/update/latest"
}
```

`path` is a **path, not a URL** — the Client resolves it against its paired server base URL (§2). The download is a `GET` carrying the same `x-client-token` header as the socket: one auth rule for every client→server call, and a revoked Client stops receiving builds for free.

The Client downloads in the background, verifies the hash, and on mismatch **discards and logs** rather than retrying in a loop. Version comparison is the Client decision — the server announces "latest", it does not command an upgrade.

### 6.8 `request-status` · implemented

The whole life of a Request in one message type (§5.3).

```json
{ "type": "request-status", "state": "approved", "minutes": 20 }
```

| `state` | Extra fields | Meaning |
|---|---|---|
| `pending` | `minutes` | Recorded. A parent has not answered yet. |
| `duplicate` | `minutes` (of the open Request) | This Client already has an open Request; asking again does not stack. |
| `cooldown` | `retryAfter` (seconds) | Declined recently. 15 minutes must pass before asking again. |
| `approved` | `minutes` | A parent gave this many minutes. **Not** necessarily the number asked for. |
| `declined` | *(none)* | A parent said no. |

`approved` and `declined` are the only two that are *verdicts*, and the only two the Client keeps: an approval is applied exactly like a positive `adjust` (§6.4) and logged as `request-approved`; a decline becomes a message the kid must dismiss, logged as `request-declined`. The other three are transient toasts and leave no trace.

Verdicts are the one server→client message that is **not purely live-only**. If the Client was offline when the Admin answered, the verdict is held and re-sent immediately after `hello` on the next connect — but only for 30 minutes from the decision, and never past local midnight. Past that it lapses, and the *parent* is told it never landed (the kid is told nothing, because from their side nothing happened). An unrecognised `state` is ignored, so a newer server may add one.

### 6.10 `coupon-status` · implemented

The answer to `coupon` (§5.4), sent inline on the same connection.

```json
{ "type": "coupon-status", "state": "granted", "minutes": 30 }
```

| Field | Type | Notes |
|---|---|---|
| `state` | string | `granted`, `used`, `expired`, `wrong-client`, `invalid`. Refusals are specific and honest (ADR-0017) — only `granted` spends the coupon. |
| `minutes` | int | Present **only** with `granted`. |

On `granted` the Client adds the minutes to today's Allowance (**not** a Grant — Downtime still beats them, they pause on lock, they die at local midnight) and logs `coupon-redeemed` (§7.2). Unknown `state` values are ignored (§1).

## 7. Vocabularies

### 7.1 Ping status

| Value | Meaning |
|---|---|
| `active` | Session logged in and unlocked; Usage Time is counting. |
| `locked` | The **Windows session** is locked, logged out or asleep — the kid stepped away. Counter paused. Deliberately *not* an Admin Lock, which reports `blocked`; the client-side enum is named `ScreenLocked` for that reason. |
| `blocked` | Block Screen up — Allowance exhausted, Downtime, or an Admin Lock. |
| `grant-active` | Usable because a Grant is running, overriding Allowance and/or Downtime. |

`grant-active` takes precedence over `active` in reporting: if a Grant is running, say so, even if the Allowance would have permitted use anyway. The timeline colour is the point.

**Unrecognised values are stored verbatim and rendered as unknown**, never rewritten to a known value. The ping log is the parent's evidence; substituting a plausible status for an unrecognised one fabricates evidence, which is worse than admitting a gap in knowledge. The server logs a warning so the bug is findable.

### 7.2 Event types

| `type` | `payload` | Logged when |
|---|---|---|
| `grant-redeemed` | `{ "minutes": 25 }` | A Family Code plus minutes was accepted on the Client. |
| `adjustment-applied` | `{ "minutes": -15 }` | An `adjust` command was applied. |
| `update-installed` | `{ "from": "0.1.0", "to": "0.2.0" }` | A self-update completed and the new build started. |
| `update-rejected` | `{ "version": "0.2.0", "reason": "sha256-mismatch" }` | A downloaded build failed hash verification. |
| `clock-jump` | `{ "from": "...", "to": "...", "deltaSeconds": 3600 }` | Wall clock diverged from the monotonic timer beyond threshold. |
| `message-shown` | `{ "text": "..." }` | A server message was displayed. |
| `exit-via-code` | `{ "stoodDown": true }` | The app was exited with a Family Code, from the tray "Exit protection…" action or the Block Screen. `stoodDown` means the Scheduled Task will leave it alone until local midnight or the next reboot (ADR-0004); absent means the watchdog restarts it within the minute. |
| `remote-kill` | *(none)* | A `kill` command was received and honoured. |
| `os-shutdown` | *(none)* | Clean shutdown or logoff; the running marker was cleared. |
| `unclean-exit` | `{ "lastTick": "2026-08-18T21:04:00+02:00" }` | Inferred at startup from a still-present running marker. Kill, crash, and power loss are deliberately indistinguishable (PRD §6.6). |
| `time-requested` | `{ "minutes": 30 }` | The kid asked a parent for more time (§5.3). Logged whether or not anyone ever answers — an unanswered ask is the more interesting half of that record. |
| `request-approved` | `{ "minutes": 20 }` | A parent approved a Request. The minutes are the ones actually given, not the ones asked for. Distinct from `adjustment-applied` even though the effect is identical, because "she asked and I said yes" and "I added time unprompted" are different facts. |
| `request-declined` | *(none)* | A parent declined a Request. |
| `server-unreachable` | `{ "blindSeconds": 10800 }` | The Client has been *running* for over an hour without reaching the server, and has been enforcing its last-known settings the whole time. Emitted at most once per run, while offline — so it necessarily arrives late, on the next successful connection. Keyed on time spent running rather than on the last-contact timestamp: a PC simply switched off overnight has a long gap and nothing to report. |
| `coupon-redeemed` | `{ "code": "KRTVXM030", "minutes": 30 }` | Logged when a `coupon-status: granted` lands. The code appears in the payload because the parent's list may no longer hold the coupon (revoke is delete, ADR-0017) — the timeline is the audit. |

A code redeemed for a Grant cannot later be reused to exit, and vice versa — the Client remembers the last redeemed code and rejects reuse (PRD §4).

### 7.3 Settings object

| Field | Type | Default | Notes |
|---|---|---|---|
| `client_id` | int | — | Present on the wire because the object is the DB row verbatim. The Client ignores it. |
| `downtime_start` | `"HH:MM"` | `"21:00"` | Client local time. |
| `downtime_end` | `"HH:MM"` | `"07:00"` | Wraps past midnight when `end < start` — the common case. |
| `weekday_minutes` | int | `120` | Allowance Mon–Fri. |
| `weekend_minutes` | int | `180` | Allowance Sat–Sun. |

## 8. Event delivery

Events are queued locally while offline and flushed on reconnect (PRD §6.4). There is **no acknowledgement** and no server-side command queue. Delivery is made safe by identity instead: see [ADR-0001](./docs/adr/0001-event-sequence-numbers-not-acks.md).

**The rules, in full:**

1. Every Event gets a **`seq`** when it is created — per-Client, monotonic, starting at 1 — persisted with the counter state before the Event is considered logged.
2. The server enforces `UNIQUE(client_id, seq)` and inserts with `INSERT OR IGNORE`. A re-sent Event is discarded silently and harmlessly.
3. The Client may therefore re-send its entire queue after any failure without reasoning about what landed. A socket death mid-flush costs nothing.
4. `hello` carries **`lastSeq`**, the server's high-water mark. On connect the Client sets its next sequence to `max(local, lastSeq + 1)`, which repairs any divergence — including the power-loss case where the state file was truncated after Events were sent but before the counter was flushed.

**Why the state file holds the Client Token and `next_seq` together:** losing it un-pairs the Client, forcing a re-pair, which allocates a *new* `client_id`. A fresh `client_id` cannot collide with the old one's sequence space. The dangerous case — a Client that keeps its identity but forgets its counter — is structurally impossible for total loss, and rule 4 covers partial loss.

The failure this design exists to prevent: a Client that resets to `seq: 1` while keeping its `client_id` would have its genuinely new Events silently swallowed by `INSERT OR IGNORE` as duplicates. Silent loss in the audit trail is the one outcome this system must not have.

## 9. Grant Code derivation

Not a wire message — a Grant Code is typed by a human — but it is a shape three codebases must agree on
byte for byte, so it is frozen here. Implemented in `client/Client.Core/GrantCode.cs`,
`server/src/grant-code.js` and `server/public/family-code.js`, and pinned to shared vectors by
`server/test/grant-code.test.js` and `Client.Core.Tests/GrantCodeTests.cs`.

```
step    = floor(unixSeconds / 60)
mac     = HMAC-SHA256(seedBytes, ascii("<minutes>:<step>"))
offset  = mac[31] & 0x0f
binary  = ((mac[offset] & 0x7f) << 24) | (mac[offset+1] << 16) | (mac[offset+2] << 8) | mac[offset+3]
code    = zeroPad6(binary mod 1000000) ++ decimal(minutes)
```

- `seedBytes` is the Grant Seed decoded from its 64 hex characters.
- `minutes` is 1–999, decimal, unpadded — and appears **twice**: inside the MAC and appended in the clear.
  That is what makes editing the trailing number invalidate the code rather than mint time.
- The verifier accepts `step-1`, `step`, and `step+1`, so a code is good for roughly two minutes. `+1`
  as well as `-1` because a Client running fast must not silently refuse valid codes.
- Truncation is RFC 4226's, matching the TOTP path, so there is one MAC→digits reduction in the system.
- The split back into digits and minutes is positional: the first six characters are always the digits,
  so the six must stay zero-padded. A code is 7–9 characters.

There is no fallback. A Client with no Grant Seed refuses every Grant Code — see ADR-0006 for why a
compatibility path was rejected.

## 10. Decisions recorded

- [ADR-0001 — Event sequence numbers, not acknowledgements](./docs/adr/0001-event-sequence-numbers-not-acks.md)
- [ADR-0005 — Request verdicts outlive the socket](./docs/adr/0005-request-verdicts-outlive-the-socket.md)
- [ADR-0006 — Grant Codes are derived from a separate Grant Seed](./docs/adr/0006-grant-codes-are-derived-from-a-separate-grant-seed.md)
- [ADR-0007 — A Client without a Family Code secret enforces nothing](./docs/adr/0007-a-client-without-a-family-code-secret-enforces-nothing.md)
- [ADR-0017 — Time Coupons are lettered, server-checked, and top up the Allowance](./docs/adr/0017-time-coupons-are-lettered-server-checked-and-top-up-the-allowance.md)
