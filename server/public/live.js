// Keeps the parts of a page that show *now* honest, by re-fetching server-rendered fragments and
// swapping them in. Deliberately not a JSON API: the timeline SVG and the client cards are rendered
// by EJS partials that the full page also uses, so there is never a second copy of that markup here.
//
// Contract: an element carrying data-live-src is refreshed from that URL every data-live-every ms.
// A marked region is replaced wholesale, so it must not contain state the browser owns — except
// keyboard focus, which is guarded below: the Requests list carries the minutes box a parent types
// into, and a poll that landed mid-keystroke would eat the number.

const regions = [...document.querySelectorAll('[data-live-src]')];
if (regions.length) {
  const timers = new Map();

  async function refresh(el) {
    // Never swap out from under the cursor. Skipping a tick costs a few seconds of staleness;
    // replacing a focused input costs the Admin whatever they had typed.
    if (el.contains(document.activeElement) && document.activeElement !== document.body) return;
    try {
      const res = await fetch(el.dataset.liveSrc, { headers: { 'x-fragment': '1' } });
      // Session expired: the fragment route redirects to /login, so hand the whole page over
      // rather than quietly painting a login form inside a card.
      if (res.redirected) { location.reload(); return; }
      if (!res.ok) return;
      swap(el, await res.text());
      if ('liveOnline' in el.dataset) syncOnlineOnly(el);
    } catch {
      // Offline or the server went away. Keep showing the last good render; the next tick retries.
    }
  }

  // Rows that appeared since the previous render get a brief highlight. Anything louder than this
  // is alerting, which is a separate feature with its own transport.
  function swap(el, html) {
    const seen = new Set([...el.querySelectorAll('[data-live-key]')].map((n) => n.dataset.liveKey));
    el.innerHTML = html;
    if (!seen.size) return;
    for (const node of el.querySelectorAll('[data-live-key]')) {
      if (!seen.has(node.dataset.liveKey)) node.classList.add('is-new');
    }
  }

  // Live-only actions (lock, message, adjust) are greyed out server-side when the PC is offline, but
  // they live in forms that can never be repainted — a swap would eat a half-typed message. So the
  // status dot carries the state for them: the region that owns the dot says so with
  // data-live-online, and every swap of it flips the marked buttons. A PC that wakes up while the
  // page sits open makes its own panel usable within a tick, instead of waiting for a reload.
  function syncOnlineOnly(el) {
    const dot = el.querySelector('.dot');
    if (!dot) return;
    const online = dot.classList.contains('online');
    for (const b of document.querySelectorAll('[data-online-only]')) b.disabled = !online;
  }

  function start(el) {
    stop(el);
    const every = Number(el.dataset.liveEvery) || 5000;
    timers.set(el, setInterval(() => refresh(el), every));
  }

  function stop(el) {
    clearInterval(timers.get(el));
    timers.delete(el);
  }

  // A backgrounded tab is a phone in a pocket. Stop entirely, then catch up the moment it returns —
  // which is also the moment the number actually needs to be right.
  document.addEventListener('visibilitychange', () => {
    for (const el of regions) {
      if (document.hidden) stop(el);
      else { refresh(el); start(el); }
    }
  });

  for (const el of regions) if (!document.hidden) start(el);
}
