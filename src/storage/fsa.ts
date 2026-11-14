/**
 * Optional File System Access integration.
 *
 * When the user points the app at a folder, finished chapters are written there as
 * `.tl.json` and the combined bilingual file is refreshed automatically — so a
 * group sharing a synced folder gets the merge for free instead of mailing files
 * around. Entirely optional: everything still works through download and drag-drop.
 *
 * The directory handle is stored in IndexedDB (handles are structured-cloneable),
 * but permission is not: browsers re-prompt each session, so every entry point
 * re-requests it and degrades gracefully when refused.
 */
import { clearHandle, getHandle, putHandle, type DictionaryData } from "./db";
import type { Lang } from "../scenario/model";
import { artifactFileName, parseArtifact, serializeArtifact, type Artifact } from "./exchange";

type Permission = "granted" | "denied" | "prompt";

export interface DirectoryHandle {
  kind: "directory";
  name: string;
  queryPermission(opts: { mode: "read" | "readwrite" }): Promise<Permission>;
  requestPermission(opts: { mode: "read" | "readwrite" }): Promise<Permission>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandle>;
  values(): AsyncIterableIterator<FileHandle | DirectoryHandle>;
}

interface FileHandle {
  kind: "file" | "directory";
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}

export function isSupported(): boolean {
  return typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";
}

let cached: DirectoryHandle | null = null;

export async function pickFolder(): Promise<string> {
  if (!isSupported()) {
    throw new Error(
      "This browser cannot open a folder directly. Chrome or Edge support it; " +
        "otherwise use Export and drag files back in.",
    );
  }
  const picker = (globalThis as unknown as {
    showDirectoryPicker(opts: { mode: string }): Promise<DirectoryHandle>;
  }).showDirectoryPicker;
  const handle = await picker({ mode: "readwrite" });
  await putHandle(handle);
  cached = handle;
  return handle.name;
}

/** Handle name if one was stored, without prompting for permission. */
export async function restoreFolderName(): Promise<string | null> {
  const handle = await getHandle<DirectoryHandle>();
  if (!handle) return null;
  cached = handle;
  return handle.name;
}

export async function forgetFolder(): Promise<void> {
  cached = null;
  await clearHandle();
}

export async function hasFolder(): Promise<boolean> {
  return !!(cached ?? (await getHandle<DirectoryHandle>()));
}

async function resolveHandle(): Promise<DirectoryHandle | null> {
  const handle = cached ?? (await getHandle<DirectoryHandle>());
  if (handle) cached = handle;
  return handle ?? null;
}

/** Resolve the handle and make sure we may write to it; null when refused. */
async function writable(): Promise<DirectoryHandle | null> {
  const handle = await resolveHandle();
  if (!handle) return null;
  const opts = { mode: "readwrite" } as const;
  if ((await handle.queryPermission(opts)) === "granted") return handle;
  return (await handle.requestPermission(opts)) === "granted" ? handle : null;
}

async function requireFolder(): Promise<DirectoryHandle> {
  const dir = await writable();
  if (!dir) throw new Error("Permission to use the folder was not granted.");
  return dir;
}

export async function writeArtifact(a: Artifact): Promise<void> {
  await writeArtifactTo(await requireFolder(), a);
}

export async function writeCombined(name: string, html: string): Promise<void> {
  await writeFileIn(await requireFolder(), name, html);
}

export async function readArtifacts(): Promise<Artifact[]> {
  return readArtifactsFrom(await requireFolder());
}

export async function readFile(name: string): Promise<string> {
  return readFileIn(await requireFolder(), name);
}

export async function readArtifactsByNames(names: string[]): Promise<Artifact[]> {
  return readArtifactsByNamesFrom(await requireFolder(), names);
}

// -- dictionary backup ------------------------------------------------------

/** Same name and shape as the Dictionary screen's "Export JSON", so Import JSON reads it. */
export const DICTIONARY_FILE = "dictionary.json";

export type BackupResult = "written" | "unchanged" | "empty" | "no-permission" | "no-folder";

export function dictionaryEntryCount(dict: DictionaryData): number {
  let n = 0;
  for (const map of Object.values(dict)) n += Object.keys(map ?? {}).length;
  return n;
}

/** Union of two dictionaries; where both have a key, `over` wins. */
export function mergeDictionaries(base: DictionaryData, over: DictionaryData): DictionaryData {
  const out: DictionaryData = {};
  for (const lang of Array.from(new Set([...Object.keys(base), ...Object.keys(over)])) as Lang[]) {
    out[lang] = { ...base[lang], ...over[lang] };
  }
  return out;
}

/** How many entries of `extra` are missing from `base`. */
export function dictionaryAdditions(base: DictionaryData, extra: DictionaryData): number {
  let n = 0;
  for (const [lang, map] of Object.entries(extra)) {
    for (const key of Object.keys(map ?? {})) {
      if (!(key in (base[lang as Lang] ?? {}))) n++;
    }
  }
  return n;
}

function parseDictionaryBackup(text: string): DictionaryData {
  const bad = () =>
    new Error(`${DICTIONARY_FILE} in the folder is not a dictionary backup, so it was left untouched.`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw bad();
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw bad();
  const out: DictionaryData = {};
  for (const [lang, map] of Object.entries(raw)) {
    if (!map || typeof map !== "object" || Array.isArray(map)) throw bad();
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(map)) {
      if (typeof value === "string" && key.trim() && value.trim()) clean[key] = value;
    }
    out[lang as Lang] = clean;
  }
  return out;
}

/** The raw backup text, or null when the folder has none yet. */
async function readDictionaryText(dir: DirectoryHandle): Promise<string | null> {
  try {
    const text = await readFileIn(dir, DICTIONARY_FILE);
    return text.trim() ? text : null;
  } catch (e) {
    if ((e as Error).name === "NotFoundError") return null;
    throw e;
  }
}

/** The folder's `dictionary.json`, or null if there is none. Throws if it isn't a dictionary. */
export async function readDictionaryFrom(dir: DirectoryHandle): Promise<DictionaryData | null> {
  const text = await readDictionaryText(dir);
  return text === null ? null : parseDictionaryBackup(text);
}

export async function readDictionary(): Promise<DictionaryData | null> {
  return readDictionaryFrom(await requireFolder());
}

/**
 * Write the dictionary as `dictionary.json`, merged into what the folder already holds.
 *
 * The file may come from another browser or person, so it is never simply replaced: its
 * entries are kept and ours win on a shared key. That also means an empty or smaller local
 * dictionary can't shrink the backup. The cost is that deletions don't propagate — a name
 * removed locally stays in the file until it is edited out by hand. A file that is not
 * valid is left alone and reported rather than overwritten.
 */
export async function backupDictionaryTo(
  dir: DirectoryHandle,
  dict: DictionaryData,
): Promise<"written" | "unchanged" | "empty"> {
  const existingText = await readDictionaryText(dir);
  const existing = existingText === null ? {} : parseDictionaryBackup(existingText);
  const merged = mergeDictionaries(existing, dict);
  if (dictionaryEntryCount(merged) === 0) return "empty";
  const text = JSON.stringify(merged, null, 2);
  if (text === existingText) return "unchanged";
  await writeFileIn(dir, DICTIONARY_FILE, text);
  return "written";
}

/**
 * Back the dictionary up to the connected folder.
 *
 * Auto-backups run without a click, and a browser may have revoked the folder since the
 * last session, so a refused or impossible permission request is a result, not an error.
 * Everything else (handle lookup, reads, writes) still throws.
 */
export async function backupDictionary(dict: DictionaryData): Promise<BackupResult> {
  // Looking the handle up and querying its permission can genuinely fail (IndexedDB
  // blocked, a stale handle): those throw. Only a refused or impossible *request* is a result.
  const dir = await resolveHandle();
  if (!dir) return "no-folder";
  const opts = { mode: "readwrite" } as const;
  let state = await dir.queryPermission(opts);
  if (state !== "granted") {
    try {
      state = await dir.requestPermission(opts);
    } catch {
      return "no-permission"; // no user activation: an auto-backup can't prompt
    }
  }
  if (state !== "granted") return "no-permission";
  return backupDictionaryTo(dir, dict);
}

/**
 * Names of every file in the folder, without reading any content.
 *
 * A cheap listing so the UI can show what's there before committing to the
 * heavier `readArtifacts` parse-and-merge.
 */
export async function listFiles(): Promise<string[]> {
  return listFilesIn(await requireFolder());
}

export async function listFilesIn(dir: DirectoryHandle): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of dir.values()) {
    if (entry.kind === "file") names.push(entry.name);
  }
  return names.sort();
}

// The operations below take the handle explicitly: the handle-resolution path above
// needs a real browser picker, but the folder logic itself should be testable.

export async function writeArtifactTo(dir: DirectoryHandle, a: Artifact): Promise<void> {
  await writeFileIn(dir, artifactFileName(a), serializeArtifact(a));
}

export async function writeFileIn(
  dir: DirectoryHandle,
  name: string,
  contents: string,
): Promise<void> {
  const file = await dir.getFileHandle(name, { create: true });
  const stream = await file.createWritable();
  await stream.write(contents);
  await stream.close();
}

export async function readFileIn(dir: DirectoryHandle, name: string): Promise<string> {
  const handle = await dir.getFileHandle(name);
  const file = await handle.getFile();
  return file.text();
}

/**
 * Read specific artifact files by names.
 */
export async function readArtifactsByNamesFrom(
  dir: DirectoryHandle,
  names: string[],
): Promise<Artifact[]> {
  const out: Artifact[] = [];
  const problems: string[] = [];
  for (const name of names) {
    try {
      const text = await readFileIn(dir, name);
      if (/\.bundle\.json$/i.test(name)) {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            out.push(parseArtifact(JSON.stringify(item), name));
          }
          continue;
        }
      }
      out.push(parseArtifact(text, name));
    } catch (e) {
      problems.push(`${name}: ${(e as Error).message}`);
    }
  }
  if (problems.length && !out.length) throw new Error(problems.join("; "));
  return out;
}

/**
 * Every `.tl.json` in the folder.
 *
 * A folder shared by several people will accumulate junk; one unreadable file must
 * not cost the user the rest, so failures are collected and only raised when
 * nothing at all could be read.
 */
export async function readArtifactsFrom(dir: DirectoryHandle): Promise<Artifact[]> {
  const out: Artifact[] = [];
  const problems: string[] = [];
  for await (const entry of dir.values()) {
    if (entry.kind !== "file" || !/\.tl\.json$/i.test(entry.name)) continue;
    try {
      const file = await (entry as FileHandle).getFile();
      out.push(parseArtifact(await file.text(), entry.name));
    } catch (e) {
      problems.push(`${entry.name}: ${(e as Error).message}`);
    }
  }
  if (problems.length && !out.length) throw new Error(problems.join("; "));
  return out;
}

