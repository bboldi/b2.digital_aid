const STORAGE_KEY = 'digital-aid-theme';
const root = document.documentElement;
const button = document.getElementById('theme-toggle');
const system = matchMedia('(prefers-color-scheme: dark)');

function storedTheme() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

function applyTheme(theme) {
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  document.body.classList.toggle('dark', theme === 'dark');
  document.body.classList.toggle('light', theme === 'light');
  document.getElementById('theme-color')?.setAttribute('content', theme === 'dark' ? '#10121c' : '#eef0f7');
  if (button) {
    const label = theme === 'dark' ? button.dataset.lightLabel : button.dataset.darkLabel;
    button.setAttribute('aria-label', label);
    button.title = label;
  }
}

applyTheme(root.dataset.theme || (system.matches ? 'dark' : 'light'));

button?.addEventListener('click', () => {
  const theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(STORAGE_KEY, theme); } catch {}
  applyTheme(theme);
});

system.addEventListener('change', (event) => {
  if (!storedTheme()) applyTheme(event.matches ? 'dark' : 'light');
});
