/**
 * Persistence.
 *
 * IndexedDB, wrapped by hand rather than pulled from npm — the app needs a handful of
 * object stores and no query language. Everything the user would hate to lose lives here:
 * settings and API keys, scanned source files, job progress, translated units,
 * finished artifacts, and chapter synopses.
 *
 * Translated units are written as each chunk lands, so a closed tab costs one chunk.
 */
import type { Calibration } from "../llm/estimate";
import type { LimiterState } from "../llm/limiter";
import { DEFAULT_PRESET_ID, PRESETS, type Preset } from "../llm/presets";
import { DEFAULT_SYSTEM_PROMPT } from "../llm/prompt";
import { DEFAULT_SUMMARY_PROMPT, type SummaryLength } from "../summarize/prompt";
import type { Lang } from "../scenario/model";
import type { Job } from "../orchestrator/job";
import type { Artifact } from "./exchange";
import { artifactKey } from "./exchange";

const DB_NAME = "translate-adv";
const DB_VERSION = 2;

export interface Settings {
  targetLang: Lang;
  presetId: string;
  /** Built-ins plus anything the user added; built-ins may be edited in place. */
  presets: Preset[];
  /** Keyed by base URL, so presets sharing an endpoint share a key. */
  apiKeys: Record<string, string>;
  systemPrompt: string;
  /** User cap on chunk size; 0 means use the preset's. */
  chunkInputTokens: number;
  /** Per-model tokenizer calibration. */
  calibration: Record<string, Calibration>;
  /** Per-preset quota counters, so limits survive a reload. */
  limiter: Record<string, LimiterState>;
  /** Global dictionary of name translations, keyed by target language then JP/canonical name. */
  dictionary?: Partial<Record<Lang, Record<string, string>>>;
  /** The summarizer's own model; independent of `presetId`, which only drives translation. */
  summaryPresetId: string;
  summaryLength: SummaryLength;
  /** Send the previous chapter's synopsis with the next one. Makes the run sequential. */
  summaryCarryOver: boolean;
  /** Session-only, like `systemPrompt`. */
  summaryPrompt: string;
}

export interface SourceRecord {
  id: string;
  file: string;
  srcHash: string;
  html: string;
  addedAt: number;
  /** Free-text glossary/context the user attaches to this file, sent with every chunk. */
  note?: string;
  /**
   * User-supplied name translations, keyed by target language then by the canonical
   * display name (`nameText ?? jp`). Only present when the user has typed at least
   * one mapping. Existing records without this field are treated as having no mappings.
   */
  customNames?: Partial<Record<Lang, Record<string, string>>>;
  /** Glossary keys the user switched off for this file (they are never sent). */
  excludedTerms?: string[];
}

export interface UnitRecord {
  key: string;
  jobId: string;
  uid: string;
  text: string;
  /**
   * The translation this one replaced. One level only — enough to revert a
   * retranslation that came back worse, not a version log.
   */
  prev?: string;
  /** Set only when this line came from a different model than the job's. */
  model?: string;
  /** When this text was written. */
  at?: number;
}

/** A chapter's synopsis. `key` is `summaryKey(docId, chapterId)`. */
export interface SummaryRecord {
  key: string;
  docId: string;
  chapterId: string;
  title: string;
  markdown: string;
  model: string;
  /** `textHash` of the chapter text it was written from; a mismatch means it is stale. */
  srcHash: string;
  at: number;
  /** The user rewrote it, so regenerating asks first. */
  edited?: boolean;
}

export function defaultSettings(): Settings {
  return {
    targetLang: "en",
    presetId: DEFAULT_PRESET_ID,
    presets: PRESETS.map((p) => ({ ...p })),
    apiKeys: {},
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    chunkInputTokens: 0,
    calibration: {},
    limiter: {},
    summaryPresetId: DEFAULT_PRESET_ID,
    summaryLength: "medium",
    summaryCarryOver: true,
    summaryPrompt: DEFAULT_SUMMARY_PROMPT,
    dictionary: {
      en: {},
      "zh-hans": {},
      "zh-hant": {},
    },
  };
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings");
      if (!db.objectStoreNames.contains("sources")) db.createObjectStore("sources", { keyPath: "id" });
      if (!db.objectStoreNames.contains("jobs")) db.createObjectStore("jobs", { keyPath: "id" });
      if (!db.objectStoreNames.contains("units")) {
        db.createObjectStore("units", { keyPath: "key" }).createIndex("jobId", "jobId");
      }
      if (!db.objectStoreNames.contains("artifacts")) db.createObjectStore("artifacts");
      if (!db.objectStoreNames.contains("handles")) db.createObjectStore("handles");
      if (!db.objectStoreNames.contains("summaries")) {
        db.createObjectStore("summaries", { keyPath: "key" }).createIndex("docId", "docId");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  return (dbPromise ??= open());
}

function run<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const tx = d.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

// -- settings ---------------------------------------------------------------

export async function loadSettings(): Promise<Settings> {
  const stored = await run<Settings | undefined>("settings", "readonly", (s) => s.get("app"));
  if (!stored) return defaultSettings();
  // Merge forward so a new built-in preset or a new field appears for existing users.
  // Note: systemPrompt and summaryPrompt are session-only for user experimentation and
  // always reset to the latest default on reload.
  const base = defaultSettings();
  const presets = [...stored.presets];
  for (const p of base.presets) if (!presets.some((q) => q.id === p.id)) presets.push(p);
  const dictionary = { ...base.dictionary, ...stored.dictionary };
  return {
    ...base,
    ...stored,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    summaryPrompt: DEFAULT_SUMMARY_PROMPT,
    presets,
    dictionary,
  };
}

export async function saveSettings(s: Settings): Promise<void> {
  // The prompts are session-only; do not persist user edits to IndexedDB.
  const { systemPrompt: _ignored, summaryPrompt: _ignored2, ...persistable } = s;
  await run("settings", "readwrite", (st) => st.put(persistable, "app"));
}

// -- sources ----------------------------------------------------------------

export async function putSource(rec: SourceRecord): Promise<void> {
  await run("sources", "readwrite", (s) => s.put(rec));
}

export function getSource(id: string): Promise<SourceRecord | undefined> {
  return run("sources", "readonly", (s) => s.get(id));
}

export function listSources(): Promise<SourceRecord[]> {
  return run("sources", "readonly", (s) => s.getAll());
}

export async function deleteSource(id: string): Promise<void> {
  await run("sources", "readwrite", (s) => s.delete(id));
}

// -- jobs -------------------------------------------------------------------

export async function putJob(job: Job): Promise<void> {
  await run("jobs", "readwrite", (s) => s.put(job));
}

export function getJob(id: string): Promise<Job | undefined> {
  return run("jobs", "readonly", (s) => s.get(id));
}

export function listJobs(): Promise<Job[]> {
  return run("jobs", "readonly", (s) => s.getAll());
}

export async function deleteJob(id: string): Promise<void> {
  await run("jobs", "readwrite", (s) => s.delete(id));
  await deleteUnits(id);
}

// -- units ------------------------------------------------------------------

export interface PutUnitsOptions {
  /** Keep the text being replaced on `prev`, so a bad retranslation can be undone. */
  keepPrevious?: boolean;
  /** Stamp provenance; recorded on every row written. */
  model?: string;
  at?: number;
}

/**
 * Fold one write into an existing row.
 *
 * Exported and pure so the interesting part is testable without an IndexedDB
 * implementation — the transaction wrapper around it stays untested, like the
 * rest of this file.
 */
export function mergeUnitRecord(
  old: UnitRecord | undefined,
  next: { jobId: string; uid: string; text: string },
  opts: PutUnitsOptions = {},
): UnitRecord {
  const prev = opts.keepPrevious && old && old.text !== next.text ? old.text : old?.prev;
  return {
    key: `${next.jobId}::${next.uid}`,
    jobId: next.jobId,
    uid: next.uid,
    text: next.text,
    ...(prev !== undefined ? { prev } : {}),
    ...(opts.model ? { model: opts.model } : old?.model ? { model: old.model } : {}),
    ...(opts.at ? { at: opts.at } : {}),
  };
}

export async function putUnits(
  jobId: string,
  translations: Map<string, string>,
  opts: PutUnitsOptions = {},
): Promise<void> {
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = d.transaction("units", "readwrite");
    const store = tx.objectStore("units");
    for (const [uid, text] of translations) {
      const key = `${jobId}::${uid}`;
      if (!opts.keepPrevious) {
        store.put(mergeUnitRecord(undefined, { jobId, uid, text }, opts));
        continue;
      }
      // Read-then-write inside the same transaction, so `prev` cannot race.
      const read = store.get(key);
      read.onsuccess = () => {
        store.put(mergeUnitRecord(read.result as UnitRecord | undefined, { jobId, uid, text }, opts));
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function getUnitRecords(jobId: string): Promise<UnitRecord[]> {
  return db().then(
    (d) =>
      new Promise<UnitRecord[]>((resolve, reject) => {
        const tx = d.transaction("units", "readonly");
        const req = tx.objectStore("units").index("jobId").getAll(jobId);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

/**
 * Swap `text` and `prev` for the given uids, and return what was restored.
 *
 * Self-inverse, so the revert of a revert is the retranslation again.
 */
export async function revertUnits(jobId: string, uids: string[]): Promise<Map<string, string>> {
  const d = await db();
  const restored = new Map<string, string>();
  await new Promise<void>((resolve, reject) => {
    const tx = d.transaction("units", "readwrite");
    const store = tx.objectStore("units");
    for (const uid of uids) {
      const req = store.get(`${jobId}::${uid}`);
      req.onsuccess = () => {
        const row = req.result as UnitRecord | undefined;
        if (!row || row.prev === undefined) return;
        restored.set(uid, row.prev);
        store.put({ ...row, text: row.prev, prev: row.text });
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  return restored;
}

export async function getUnits(jobId: string): Promise<Map<string, string>> {
  const rows = await db().then(
    (d) =>
      new Promise<UnitRecord[]>((resolve, reject) => {
        const tx = d.transaction("units", "readonly");
        const req = tx.objectStore("units").index("jobId").getAll(jobId);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
  return new Map(rows.map((r) => [r.uid, r.text]));
}

async function deleteUnits(jobId: string): Promise<void> {
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = d.transaction("units", "readwrite");
    const index = tx.objectStore("units").index("jobId");
    const req = index.openKeyCursor(IDBKeyRange.only(jobId));
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return;
      tx.objectStore("units").delete(cur.primaryKey);
      cur.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// -- artifacts --------------------------------------------------------------

export async function putArtifact(a: Artifact): Promise<void> {
  await run("artifacts", "readwrite", (s) => s.put(a, artifactKey(a)));
}

export function listArtifacts(): Promise<Artifact[]> {
  return run("artifacts", "readonly", (s) => s.getAll());
}

export function getArtifact(key: string): Promise<Artifact | undefined> {
  return run("artifacts", "readonly", (s) => s.get(key));
}

export async function deleteArtifact(key: string): Promise<void> {
  await run("artifacts", "readwrite", (s) => s.delete(key));
}

// -- summaries --------------------------------------------------------------

export async function putSummary(rec: SummaryRecord): Promise<void> {
  await run("summaries", "readwrite", (s) => s.put(rec));
}

export function listSummaries(docId: string): Promise<SummaryRecord[]> {
  return db().then(
    (d) =>
      new Promise<SummaryRecord[]>((resolve, reject) => {
        const tx = d.transaction("summaries", "readonly");
        const req = tx.objectStore("summaries").index("docId").getAll(docId);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function deleteSummary(key: string): Promise<void> {
  await run("summaries", "readwrite", (s) => s.delete(key));
}

// -- directory handle (File System Access) ----------------------------------

export async function putHandle(handle: unknown): Promise<void> {
  await run("handles", "readwrite", (s) => s.put(handle, "folder"));
}

export function getHandle<T>(): Promise<T | undefined> {
  return run("handles", "readonly", (s) => s.get("folder"));
}

export async function clearHandle(): Promise<void> {
  await run("handles", "readwrite", (s) => s.delete("folder"));
}
