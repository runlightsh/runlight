import type { ComponentChildren } from "preact";
import en from "./locales/en.json";

export type Messages = typeof en;
export type Key = keyof Messages;

/** Languages the dashboard speaks, by their own names. */
export const LANGUAGES: Array<[code: string, name: string]> = [
  ["en", "English"],
  ["fr", "Français"],
  ["es", "Español"],
  ["de", "Deutsch"],
  ["pt", "Português"],
];

const STORAGE = "runlight_language";
const urls: Record<string, string> = (() => {
  try {
    return JSON.parse(document.getElementById("app")?.dataset.locales ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
})();

let locale = "en";
let messages: Messages = en;
let plurals = new Intl.PluralRules("en");

export function currentLocale(): string {
  return locale;
}

/**
 * The language the dashboard's host is in, when it says: a CMS page that frames or links to the dashboard adds
 * ?lang= to the address, and a CMS that runs Runlight also names its own in data-lang, for an address without.
 */
const HOST_LANGUAGE = ((): string => {
  try {
    return new URLSearchParams(location.search).get("lang") || (document.getElementById("app")?.dataset.lang ?? "");
  } catch {
    return "";
  }
  // Read as the page loads: the dashboard rewrites its address once it starts, without what it does not know.
})();

/**
 * The language to start in: the one picked here before; else the host's, or English when the dashboard does
 * not have the host's; else the browser's; else English.
 */
export function initialLocale(stored: string | null = storedLocale(), host = HOST_LANGUAGE, browser: readonly string[] = navigator.languages ?? [navigator.language]): string {
  const known = (tag: string | null | undefined): string | undefined => {
    const code = (tag ?? "").toLowerCase().split(/[-_]/)[0]!;
    return LANGUAGES.some(([c]) => c === code) ? code : undefined;
  };
  const picked = known(stored);
  if (picked) return picked;
  if (host) return known(host) ?? "en";
  for (const tag of browser) {
    const code = known(tag);
    if (code) return code;
  }
  return "en";
}

function storedLocale(): string | null {
  try {
    return localStorage.getItem(STORAGE);
  } catch {
    return null;
  }
}

/** Loads a language (only English is in the bundle) and makes it current. */
export async function setLocale(code: string, remember = false): Promise<void> {
  if (code === "en") {
    messages = en;
  } else {
    const url = urls[code];
    if (!url) throw new Error(`No messages for ${code}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not load ${code}`);
    messages = { ...en, ...((await response.json()) as Partial<Messages>) };
  }
  locale = code;
  plurals = new Intl.PluralRules(code);
  document.documentElement.lang = code;
  if (remember) {
    try {
      localStorage.setItem(STORAGE, code);
    } catch {}
  }
}

function fill(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

/** Whether a key has words, for keys made from a code. */
export function hasKey(key: string): key is Key {
  return Object.prototype.hasOwnProperty.call(en, key);
}

/** A message, with {name} placeholders filled. */
export function t(key: Key, vars: Record<string, string | number> = {}): string {
  return fill(messages[key] ?? en[key] ?? key, vars);
}

/**
 * A counted message: `key_one`, `key_other` (and any other plural forms the
 * language has), chosen by Intl.PluralRules, with {n} filled.
 */
export function tn(key: string, n: number, vars: Record<string, string | number> = {}): string {
  const form = plurals.select(n);
  const table = messages as unknown as Record<string, string>;
  const text = table[`${key}_${form}`] ?? table[`${key}_other`] ?? (en as unknown as Record<string, string>)[`${key}_other`] ?? key;
  return fill(text, { n, ...vars });
}

/** A server error in this language, from the code it sent; null when the dashboard has no words for that code. */
export function errorText(code: string, vars: Record<string, string> = {}): string | null {
  const key = `error.${code}`;
  const all = { ...(en as unknown as Record<string, string>), ...(messages as unknown as Record<string, string>) };
  const text = all[key];
  if (text === undefined) return null;
  // A mail setting's field comes as its name, shown with the label the settings form gives it.
  const field = vars.field && all[`mail.field.${vars.field}`];
  return fill(text, field ? { ...vars, field } : vars);
}

/** A message whose placeholders are elements, for sentences with bold or coloured parts. */
export function rich(key: Key, parts: Record<string, ComponentChildren>): ComponentChildren[] {
  const text = messages[key] ?? en[key] ?? key;
  const out: ComponentChildren[] = [];
  let last = 0;
  for (const match of text.matchAll(/\{(\w+)\}/g)) {
    out.push(text.slice(last, match.index));
    out.push(parts[match[1]!] ?? match[0]);
    last = (match.index ?? 0) + match[0].length;
  }
  out.push(text.slice(last));
  return out;
}
