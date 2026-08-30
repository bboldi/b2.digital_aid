// The Quick actions panel: dialog plumbing, and the remembered Give-time amount.

// Buttons open the dialog they name; anything marked data-close closes its own dialog. Native
// showModal() so focus is trapped and Esc works without any code here.
for (const btn of document.querySelectorAll('[data-dialog]')) {
  btn.addEventListener('click', () => document.getElementById(btn.dataset.dialog)?.showModal());
}
for (const btn of document.querySelectorAll('dialog [data-close]')) {
  btn.addEventListener('click', () => btn.closest('dialog').close());
}
// Light dismiss: a click on the backdrop lands on the <dialog> element itself, never on its
// children, so this closes on outside-click without swallowing clicks inside the form.
for (const dlg of document.querySelectorAll('dialog')) {
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
}

// The Give-time dialog remembers how much time this household gives. Most evenings it is the same
// number, so the common case should cost no taps beyond opening it.
//
// Its own key, not the one public/family-code.js writes: picking 60 minutes to read down the phone
// is a different decision from what the Client Page opens on, and sharing the key would let one
// quietly rewrite the other.
const KEY = 'da.quickMinutes';

const select = document.getElementById('quick-minutes');
if (select) {
  const saved = localStorage.getItem(KEY);
  // Only if it is still one of the offered presets — the list can change between releases, and a
  // remembered 45 must not silently become "whatever the browser felt like selecting".
  if (saved && [...select.options].some((o) => o.value === saved)) select.value = saved;

  select.addEventListener('change', () => localStorage.setItem(KEY, select.value));
}
