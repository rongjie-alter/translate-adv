/**
 * Persistence.
 *
 * IndexedDB, wrapped by hand rather than pulled from npm — the app needs five object
 * stores and no query language. Everything the user would hate to lose lives here:
 * settings and API keys, scanned source files, job progress, translated units, and
 * finished artifacts.
 *
 * Translated units are written as each chunk lands, so a closed tab costs one chunk.
 */
import type { Calibration } from "../llm/estimate";
import type { LimiterState } from "../llm/limiter";
import { DEFAULT_PRESET_ID, PRESETS, type Preset } from "../llm/presets";
import { DEFAULT_SYSTEM_PROMPT } from "../llm/prompt";
import type { Lang } from "../scenario/model";
import type { Job } from "../orchestrator/job";
import type { Artifact } from "./exchange";
import { artifactKey } from "./exchange";

const DB_NAME = "translate-adv";
const DB_VERSION = 1;

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
}

export interface SourceRecord {
  id: string;
  file: string;
  srcHash: string;
  html: string;
  addedAt: number;
}

export interface UnitRecord {
  key: string;
  jobId: string;
  uid: string;
  text: string;
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
  const base = defaultSettings();
  const presets = [...stored.presets];
  for (const p of base.presets) if (!presets.some((q) => q.id === p.id)) presets.push(p);
  return { ...base, ...stored, presets };
}

export async function saveSettings(s: Settings): Promise<void> {
  await run("settings", "readwrite", (st) => st.put(s, "app"));
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

export async function putUnits(jobId: string, translations: Map<string, string>): Promise<void> {
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = d.transaction("units", "readwrite");
    const store = tx.objectStore("units");
    for (const [uid, text] of translations) {
      store.put({ key: `${jobId}::${uid}`, jobId, uid, text } satisfies UnitRecord);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
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
