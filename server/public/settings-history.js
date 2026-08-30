// The settings page keeps a complete update history, but opens it in readable batches rather than
// turning a rarely used maintenance panel into a wall of rows.
export function revealNext(rows, batch = 10) {
  rows.filter((row) => row.hidden).slice(0, batch).forEach((row) => { row.hidden = false; });
  return rows.some((row) => row.hidden);
}

const more = typeof document === 'undefined' ? null : document.getElementById('updates-more');

if (more) {
  const rows = [...document.querySelectorAll('[data-update-row]')];
  const batch = Number(more.dataset.batch) || 10;

  more.addEventListener('click', () => {
    more.hidden = !revealNext(rows, batch);
  });
}
