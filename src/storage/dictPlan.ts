/**
 * Planning a dictionary import or backup.
 *
 * Pure, like `importPlan.ts`. The dictionary has no timestamps and no deletion
 * history, so nothing here can tell "added elsewhere" from "deleted here": the
 * defaults lean on the browser, where the user edits, and the dialog lets them
 * override each entry.
 *
 * - import (Import JSON): entries only in the file are added; a clash keeps the
 *   browser's value; entries only in the browser are never touched.
 * - backup (to `dictionary.json` in the folder): the result is written to both the
 *   browser and the file. Browser-only entries go to the file; a clash keeps the
 *   browser's value; an entry only in the file is dropped unless kept — but kept by
 *   default when the browser has no entries at all for that language.
 */
import { LANGS, type Lang } from "../scenario/model";

export type DictionaryData = Partial<Record<Lang, Record<string, string>>>;

export type DictSide = "mine" | "theirs";

export interface DictDiff {
  /** `lang` and `key`, joined; stable across renders. */
  id: string;
  lang: Lang;
  key: string;
  mine?: string;
  theirs?: string;
  /**
   * - `added`: only in the file; import adds it without asking.
   * - `browser-only`: only in the browser; backup writes it without asking.
   * - `clash`: both, with different values.
   * - `file-only`: only in the file, during a backup; a decision.
   */
  kind: "added" | "browser-only" | "clash" | "file-only";
  /** Overrides the default side; set when the browser has nothing for this language. */
  suggested?: DictSide;
}

export interface DictPlan {
  mode: "import" | "backup";
  /** Identical entries are left out. */
  diffs: DictDiff[];
}

export type DictChoices = Record<string, DictSide>;

export function planDictImport(mine: DictionaryData, incoming: DictionaryData): DictPlan {
  return { mode: "import", diffs: diff(mine, incoming, "import") };
}

export function planDictBackup(mine: DictionaryData, file: DictionaryData): DictPlan {
  return { mode: "backup", diffs: diff(mine, file, "backup") };
}

function diff(mine: DictionaryData, theirs: DictionaryData, mode: DictPlan["mode"]): DictDiff[] {
  const out: DictDiff[] = [];
  for (const lang of LANGS) {
    const a = mine[lang] ?? {};
    const b = theirs[lang] ?? {};
    // An empty browser side is a fresh or cleared profile, not one where the user deleted
    // every entry: dropping the file's entries would turn a backup into a wipe.
    const keepFileOnly = mode === "backup" && Object.keys(a).length === 0;
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const m = a[key];
      const t = b[key];
      if (m === t) continue;
      const id = `${lang}\u0000${key}`;
      if (m === undefined) {
        out.push({
          id,
          lang,
          key,
          theirs: t,
          kind: mode === "import" ? "added" : "file-only",
          ...(keepFileOnly ? { suggested: "theirs" as const } : {}),
        });
      } else if (t === undefined) {
        if (mode === "backup") out.push({ id, lang, key, mine: m, kind: "browser-only" });
      } else {
        out.push({ id, lang, key, mine: m, theirs: t, kind: "clash" });
      }
    }
  }
  return out;
}

export function isDecision(d: DictDiff): boolean {
  return d.kind === "clash" || d.kind === "file-only";
}

export function hasDictDecisions(plan: DictPlan): boolean {
  return plan.diffs.some(isDecision);
}

/**
 * Added entries take the file's value; everything else defaults to the browser's,
 * except file-only entries of a language the browser has nothing for, which are kept.
 */
export function defaultDictSide(d: DictDiff): DictSide {
  return d.suggested ?? (d.kind === "added" ? "theirs" : "mine");
}

export function defaultDictChoices(plan: DictPlan): DictChoices {
  return Object.fromEntries(plan.diffs.map((d) => [d.id, defaultDictSide(d)] as const));
}

/** Every decision set to one side; automatic entries keep their default. */
export function allDictChoices(plan: DictPlan, side: DictSide): DictChoices {
  const base = defaultDictChoices(plan);
  for (const d of plan.diffs) if (isDecision(d)) base[d.id] = side;
  return base;
}

/** The browser dictionary after applying `choices`. */
export function resolveDict(mine: DictionaryData, plan: DictPlan, choices: DictChoices): DictionaryData {
  const out: DictionaryData = {};
  for (const lang of LANGS) out[lang] = { ...(mine[lang] ?? {}) };
  for (const d of plan.diffs) {
    const side = choices[d.id] ?? defaultDictSide(d);
    const value = side === "theirs" ? d.theirs : d.mine;
    const map = out[d.lang]!;
    if (value === undefined) delete map[d.key];
    else map[d.key] = value;
  }
  return out;
}

export interface DictSummary {
  added: number;
  changed: number;
  removed: number;
}

/** How the browser dictionary changes; for the toast. */
export function summarizeDict(before: DictionaryData, after: DictionaryData): DictSummary {
  const s: DictSummary = { added: 0, changed: 0, removed: 0 };
  for (const lang of LANGS) {
    const a = before[lang] ?? {};
    const b = after[lang] ?? {};
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (a[key] === b[key]) continue;
      if (a[key] === undefined) s.added++;
      else if (b[key] === undefined) s.removed++;
      else s.changed++;
    }
  }
  return s;
}

export function describeDict(s: DictSummary): string {
  const parts: string[] = [];
  if (s.added) parts.push(`${s.added} added`);
  if (s.changed) parts.push(`${s.changed} changed`);
  if (s.removed) parts.push(`${s.removed} removed`);
  return parts.length ? parts.join(", ") : "no changes";
}

export class DictionaryFileError extends Error {}

/**
 * Read a dictionary file: the per-language shape Export JSON writes, or (only
 * when `flatLang` is given) a flat `{ name: translation }` map for that language.
 * Keys and values are trimmed; empty ones and non-strings are dropped.
 */
export function parseDictionaryFile(text: string, flatLang?: Lang): DictionaryData {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new DictionaryFileError(`not valid JSON: ${(e as Error).message}`);
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new DictionaryFileError("not a dictionary file");
  }
  const obj = json as Record<string, unknown>;
  const perLang = LANGS.some((l) => l in obj);
  if (!perLang && !flatLang) {
    throw new DictionaryFileError("not a dictionary backup (no language sections)");
  }
  const out: DictionaryData = {};
  for (const lang of LANGS) {
    const section = perLang ? obj[lang] : lang === flatLang ? obj : undefined;
    out[lang] = cleanMap(section);
  }
  return out;
}

function cleanMap(section: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  if (!section || typeof section !== "object" || Array.isArray(section)) return map;
  for (const [k, v] of Object.entries(section)) {
    if (typeof v !== "string") continue;
    const key = k.trim();
    const value = v.trim();
    if (key && value) map[key] = value;
  }
  return map;
}

/** The text Export JSON downloads and the backup writes. */
export function serializeDictionary(d: DictionaryData): string {
  return JSON.stringify(d, null, 2);
}

export function entryCount(d: DictionaryData): number {
  return LANGS.reduce((n, l) => n + Object.keys(d[l] ?? {}).length, 0);
}
