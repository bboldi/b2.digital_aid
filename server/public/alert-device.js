// Turning this browser into an Alert Device (CONTEXT.md: Alert Device).
//
// Per-browser, not per-person: two parents each install the app and each become one, and a phone and
// a laptop are two. Independent of Trusted Device and Remember Me — a work laptop worth alerting is
// not necessarily one worth handing the Admin Code secret to.
//
// Everything here needs a secure context. Service workers and PushManager are HTTPS-only and a
// self-signed certificate will not do, so on a LAN IP this page correctly reports "unsupported"
// rather than failing halfway through subscribing.

const box = document.getElementById('alerts-device');
if (box) {
  const button = document.getElementById('alerts-toggle');
  const status = document.getElementById('alerts-status');
  const test = document.getElementById('alerts-test');
  const key = box.dataset.vapid;
  // Handed down from the page as a JSON island, the same way the Codes page feeds family-code.js:
  // EJS cannot render a static asset, and a second copy of the catalogue in JavaScript would be a
  // second thing to keep in step.
  const STRINGS = JSON.parse(document.getElementById('alert-strings')?.textContent ?? '{}');
  const T = (key) => STRINGS[key] ?? '';

  const supported = 'serviceWorker' in navigator && 'PushManager' in window && !!key;

  function say(text, kind = 'muted') {
    status.textContent = text;
    status.className = kind;
  }

  // A VAPID public key travels as base64url and PushManager wants raw bytes.
  function decodeKey(base64url) {
    const padded = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(padded);
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  }

  async function current() {
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }

  async function paint() {
    if (!supported) {
      button.disabled = true;
      say(T('alerts.unsupported'), 'error');
      return;
    }
    if (Notification.permission === 'denied') {
      button.disabled = true;
      say(T('alerts.denied'), 'error');
      return;
    }
    const sub = await current();
    button.textContent = sub ? T('alerts.disableHere') : T('alerts.enableHere');
    test.hidden = !sub;
    say(sub ? T('alerts.on') : '');
  }

  async function enable() {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return paint();

    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      // Required to be true by every browser that implements this: a push may not be used to wake a
      // page silently, only to show something. That constraint suits an Alert exactly.
      userVisibleOnly: true,
      applicationServerKey: decodeKey(key),
    });
    // A label so the settings list is readable — this is the only thing the server ever learns
    // about the device, and it is a hint for a human, not an identity.
    await post('/alerts/subscribe', { subscription: sub.toJSON(), label: navigator.userAgent.slice(0, 120) });
    return paint();
  }

  async function disable() {
    const sub = await current();
    if (!sub) return paint();
    // Told to the server first: if unsubscribing succeeds locally and the POST then fails, the row
    // lingers and the household pays to send to an endpoint that no longer exists. This way round
    // the worst case is a subscription the browser still holds and the server has forgotten, which
    // costs nothing and heals the next time this button is pressed.
    await post('/alerts/unsubscribe', { endpoint: sub.endpoint });
    await sub.unsubscribe();
    return paint();
  }

  async function post(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(String(res.status));
    return res.json();
  }

  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const sub = await current();
      await (sub ? disable() : enable());
    } catch (err) {
      say(String(err.message || err), 'error');
    } finally {
      button.disabled = false;
    }
  });

  test.addEventListener('click', async () => {
    try {
      await post('/alerts/test', {});
      say(T('alerts.testSent'));
    } catch (err) {
      say(String(err.message || err), 'error');
    }
  });

  paint();
}
