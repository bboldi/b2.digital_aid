import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The admin UI in English and Hungarian.
//
// No i18n dependency: what is needed here is one function and two JSON files, and this project has a
// standing habit of not taking a package for that (the TOTP and the Pico stylesheet went the same
// way). Catalogues are read once at startup — they are two small files that only change when the
// server is redeployed, and a per-request read would be work done a few thousand times a day to
// notice an edit nobody made.
//
// The Client's language is a separate matter entirely and is chosen on the PC (ADR-0012). This
// setting is the *admin UI's* language: it belongs to the parent's browser and nothing else.

export const LANGUAGES = ['en', 'hu'];
export const DEFAULT_LANGUAGE = 'en';

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogues = Object.fromEntries(LANGUAGES.map((lang) => [lang, load(lang)]));

function load(lang) {
  try {
    return JSON.parse(fs.readFileSync(path.join(here, '..', 'locales', `${lang}.json`), 'utf8'));
  } catch {
    // A missing catalogue must not take the server down — an admin who cannot log in cannot fix it.
    return {};
  }
}

export const isSupported = (lang) => LANGUAGES.includes(lang);

/**
 * Which language to render in: the Admin's stored choice, else what the browser asks for, else
 * English.
 *
 * The header only ever decides the setup wizard, which runs before there is an admin row to hold a
 * preference — but that is the one screen where getting it wrong costs the most, because it is the
 * first thing anyone sees and the point at which they give up.
 */
export function resolveLanguage(req, admin) {
  if (isSupported(admin?.lang)) return admin.lang;
  return fromAcceptLanguage(req?.headers?.['accept-language']) ?? DEFAULT_LANGUAGE;
}

/** First supported language in a q-ordered Accept-Language, or null. Region tags are ignored: there
 *  is one Hungarian here, not hu-HU and hu-RO. */
function fromAcceptLanguage(header) {
  if (typeof header !== 'string') return null;

  const ranked = header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      return { tag: tag.trim().toLowerCase().split('-')[0], q: q ? Number(q.slice(2)) : 1 };
    })
    .filter((entry) => Number.isFinite(entry.q) && entry.q > 0)
    .sort((a, b) => b.q - a.q);

  return ranked.find((entry) => isSupported(entry.tag))?.tag ?? null;
}

/**
 * Look up `key` in `lang` and fill in `{0}`, `{1}`… from `vars`.
 *
 * A missing key renders as `[key]` rather than falling back to English. That is deliberate and is
 * the whole quality-control mechanism on this side: a visibly untranslated string gets reported and
 * fixed, while one that silently reads correctly in English is a hole nobody ever finds. The client
 * half gets the same protection from a test that compares the two catalogues; here the page says it.
 *
 * Every entry containing a number is a whole sentence with a placeholder, never a noun concatenated
 * to a figure — Hungarian does not pluralise after a numeral, so "5 minutes" and "5 perc" cannot be
 * assembled from the same pieces (CONTEXT.md: Hungarian terms).
 */
export function translate(lang, key, vars) {
  const value = catalogues[isSupported(lang) ? lang : DEFAULT_LANGUAGE]?.[key];
  if (typeof value !== 'string') return `[${key}]`;
  if (vars === undefined) return value;

  const list = Array.isArray(vars) ? vars : [vars];
  return value.replace(/\{(\d+)\}/g, (whole, index) => {
    const replacement = list[Number(index)];
    return replacement === undefined ? whole : String(replacement);
  });
}

/**
 * A protocol value rendered for a human: a Ping status, an Event type, a Time Left reason.
 *
 * Unlike `translate`, an unknown value falls back to the raw string rather than to `[key]`. These
 * vocabularies are open-ended on purpose — `PROTOCOL.md` §7.1 and §7.2 say an unrecognised status or
 * Event type is stored verbatim and never coerced, precisely so a Client newer than its server keeps
 * its meaning. Rendering `[status.hibernating]` would be this server editorialising about a word it
 * simply has not learned yet, on the one screen that exists to be evidence.
 */
export function vocabulary(lang, prefix, value) {
  if (value === null || value === undefined || value === '') return '';
  const key = `${prefix}.${value}`;
  const text = translate(lang, key);
  return text === `[${key}]` ? String(value) : text;
}

/** A `vocabulary(prefix, value)` bound to one language, for handing to a template. */
export const vocabularyFor = (lang) => (prefix, value) => vocabulary(lang, prefix, value);

/** A `t(key, vars)` bound to one language, for handing to a template. */
export const translatorFor = (lang) => (key, vars) => translate(lang, key, vars);

/** Every key in a catalogue — for the parity test, and nothing else. */
export const keysOf = (lang) => Object.keys(catalogues[lang] ?? {});
