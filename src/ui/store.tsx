/**
 * Application state and every side effect that touches storage.
 *
 * Views read from here and call actions; nothing else talks to IndexedDB or the
 * filesystem directly. Kept as one context rather than a state library because the
 * whole app is four screens over five object stores.
 */
import { createContext } from "preact";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { findPreset, type Preset } from "../llm/presets";
import type { Calibration } from "../llm/estimate";
import { OUTPUT_RATIO } from "../llm/estimate";
import { RateLimiter, emptyState } from "../llm/limiter";
import * as db from "../storage/db";
import type { Settings, SourceRecord } from "../storage/db";
import { artifactKey, parseArtifact, type Artifact } from "../storage/exchange";
import * as fsa from "../storage/fsa";
import {
  defaultChoices,
  describeImport,
  hasDecisions,
  planImport,
  resolveImport,
  type ChapterPlan,
  type ImportChoices,
} from "../storage/importPlan";
import {
  defaultDictChoices,
  describeDict,
  hasDictDecisions,
  parseDictionaryFile,
  planDictBackup,
  planDictImport,
  resolveDict,
  serializeDictionary,
  summarizeDict,
  type DictChoices,
  type DictionaryData,
  type DictPlan,
} from "../storage/dictPlan";
import { hashFile, type Book, type Lang } from "../scenario/model";
import { parseBookHtml } from "../scenario/parseHtml";
import { isBilingualHtml, parseBilingualHtml, type BilingualDoc } from "../summarize/bilingualHtml";
import type { Job } from "../orchestrator/job";

import { normalizeBookBase, type BookGroup } from "../storage/groups";

export type View =
  | "scan"
  | "translate"
  | "review"
  | "library"
  | "summarize"
  | "dictionary"
  | "settings";

export interface Toast {
  id: number;
  kind: "info" | "error";
  message: string;
}

/** An import that needs the user's decisions before anything is written. */
export interface PendingImport {
  plan: ChapterPlan[];
  /** What is being imported, for the dialog title. */
  label: string;
  /** The files came from the connected folder, so only merged chapters are written back. */
  fromFolder: boolean;
}

export interface PendingDict {
  plan: DictPlan;
  label: string;
}

export interface Store {
  ready: boolean;
  settings: Settings;
  sources: SourceRecord[];
  jobs: Job[];
  artifacts: Artifact[];
  books: Map<string, Book>;
  /**
   * Dropped `.bilingual.html` files, kept for the Summarize screen only. They are not
   * persisted: the file is the source of truth, and a synopsis made from one is stored
   * under the same document id the Library would use.
   */
  bilingualDocs: BilingualDoc[];
  view: View;
  activeSourceId: string | null;
  folderName: string | null;
  /** Names only, from the last `refreshFolderFiles()` — nothing is read or parsed. */
  folderFiles: string[];
  toasts: Toast[];
  pendingImport: PendingImport | null;
  pendingDict: PendingDict | null;
  /** Filenames just uploaded that lack the consolidated `#chara-meta` JSON dict. */
  metaWarningFiles: string[];
  /** `artifactKey` of the chapter open on the Review screen. */
  reviewKey: string | null;
  /**
   * Unit ids picked for retranslation. Kept here rather than in `ReviewView`
   * because `App` unmounts the view on every tab switch, and a hand-built
   * selection of forty lines must survive a trip to Settings for an API key.
   */
  reviewSelection: ReadonlySet<string>;
  /**
   * `normalizeBookBase` of every book translated, edited, reviewed or imported since this
   * page loaded. Session-only on purpose: the Library opens exactly these groups.
   */
  touchedBooks: ReadonlySet<string>;

  setView(v: View): void;
  openReview(key: string | null): void;
  /** Accepts an updater, so rapid toggles cannot overwrite each other. */
  setReviewSelection(
    next: ReadonlySet<string> | ((prev: ReadonlySet<string>) => ReadonlySet<string>),
  ): void;
  setActiveSource(id: string | null): void;
  saveSettings(patch: Partial<Settings>): Promise<void>;
  addFiles(files: File[]): Promise<void>;
  removeSource(id: string): Promise<void>;
  updateSourceNote(id: string, note: string): Promise<void>;
  updateCustomName(id: string, lang: Lang, display: string, name: string): Promise<void>;
  /** Switch a glossary term off (or back on) for one file. */
  setTermExcluded(id: string, jp: string, excluded: boolean): Promise<void>;
  updateDictionaryName(lang: Lang, display: string, name: string): Promise<void>;
  deleteDictionaryName(lang: Lang, display: string): Promise<void>;
  importCustomNamesToDictionary(): Promise<number>;
  /** Plan an import; applies at once unless an entry clashes, else opens the dialog. */
  importDictionary(data: DictionaryData, label: string): Promise<void>;
  /** Reconcile with `dictionary.json` in the connected folder, writing both sides. */
  backupDictionary(): Promise<void>;
  clearDictionary(lang: Lang): Promise<void>;
  refreshJobs(): Promise<void>;
  saveArtifact(a: Artifact): Promise<void>;
  removeArtifact(key: string): Promise<void>;
  connectFolder(): Promise<void>;
  disconnectFolder(): Promise<void>;
  syncFolder(): Promise<void>;
  refreshFolderFiles(): Promise<void>;
  loadFolderGroup(group: Pick<BookGroup, "book" | "lang" | "artifactFiles" | "sourceFile">): Promise<void>;
  /** Deletes jobs, units, and artifacts for one book+language. Leaves the scanned source alone. */
  freeBook(book: string, lang: Lang): Promise<void>;
  toast(message: string, kind?: Toast["kind"]): void;
  applyPendingImport(choices: ImportChoices): Promise<void>;
  cancelPendingImport(): void;
  applyPendingDict(choices: DictChoices): Promise<void>;
  cancelPendingDict(): void;
  dismissMetaWarning(): void;
  activePreset(): Preset;
  /** Key for `preset`, or for the active one. A retry may target another endpoint. */
  apiKey(preset?: Preset): string;
  calibrationFor(model: string, lang: Lang, preset?: Preset): Calibration;
  /** A limiter on `preset`'s own persisted counters, never the active preset's. */
  limiterFor(preset: Preset): RateLimiter;
}

const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore outside provider");
  return s;
}

export function StoreProvider({ children }: { children: ComponentChildren }) {
  const [ready, setReady] = useState(false);
  const [settings, setSettings] = useState<Settings>(db.defaultSettings());
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [books, setBooks] = useState<Map<string, Book>>(new Map());
  const [bilingualDocs, setBilingualDocs] = useState<BilingualDoc[]>([]);
  const [view, setView] = useState<View>("scan");
  const [activeSourceId, setActiveSource] = useState<string | null>(null);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [folderFiles, setFolderFiles] = useState<string[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  /** True from the start of planning an import until it is applied or cancelled. */
  const importBusy = useRef(false);
  const [pendingDict, setPendingDict] = useState<PendingDict | null>(null);
  const [metaWarningFiles, setMetaWarningFiles] = useState<string[]>([]);
  const [reviewKey, setReviewKey] = useState<string | null>(null);
  const [reviewSelection, setReviewSelection] = useState<ReadonlySet<string>>(new Set());

  const [touchedBooks, setTouchedBooks] = useState<ReadonlySet<string>>(new Set());

  const touchBooks = useCallback((books: string[]) => {
    setTouchedBooks((prev) => {
      const bases = books.map(normalizeBookBase);
      if (bases.every((b) => prev.has(b))) return prev;
      return new Set([...prev, ...bases]);
    });
  }, []);

  const openReview = useCallback((key: string | null) => {
    // Look the book up rather than parsing the key: names may themselves contain "::".
    const book = key ? artifacts.find((a) => artifactKey(a) === key)?.book : undefined;
    if (book) touchBooks([book]);
    // Unit ids are only meaningful within one chapter, so switching chapters
    // must not carry a selection across.
    setReviewKey((prev) => {
      if (prev !== key) setReviewSelection(new Set());
      return key;
    });
    setView("review");
  }, [artifacts, touchBooks]);

  const toast = useCallback((message: string, kind: Toast["kind"] = "info") => {
    const t = { id: Date.now() + Math.random(), kind, message };
    setToasts((prev) => [...prev, t]);
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== t.id)), 6000);
  }, []);

  useEffect(() => {
    void (async () => {
      const [s, src, j, a] = await Promise.all([
        db.loadSettings(),
        db.listSources(),
        db.listJobs(),
        db.listArtifacts(),
      ]);
      setSettings(s);
      setSources(src);
      setJobs(j);
      setArtifacts(a);
      setBooks(new Map(src.map((r) => [r.id, parseBookHtml(r.file, r.html)])));
      if (src.length) setActiveSource(src[src.length - 1].id);
      setFolderName(await fsa.restoreFolderName());
      setReady(true);
    })();
  }, []);

  const saveSettings = useCallback(async (patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      void db.saveSettings(next);
      return next;
    });
  }, []);

  /** Write what an import resolved to: unit rows (revertable), artifacts, then the folder. */
  const applyImport = useCallback(
    async (pending: PendingImport, choices: ImportChoices) => {
      const result = resolveImport(pending.plan, choices, Date.now());
      for (const w of result.unitWrites) {
        // Seed a row for lines that only lived in the artifact, so the import can be reverted.
        const rows = new Set((await db.getUnitRecords(w.key)).map((r) => r.uid));
        const seed = new Map([...w.previous].filter(([uid]) => !rows.has(uid)));
        if (seed.size) await db.putUnits(w.key, seed);
        await db.putUnits(w.key, w.texts, { keepPrevious: true, model: w.model, at: w.at });
      }
      for (const { artifact } of result.artifacts) await db.putArtifact(artifact);
      if (result.artifacts.length) {
        const changed = new Map(result.artifacts.map(({ artifact }) => [artifactKey(artifact), artifact]));
        setArtifacts((prev) => [...prev.filter((a) => !changed.has(artifactKey(a))), ...changed.values()]);
        touchBooks(result.artifacts.map(({ artifact }) => artifact.book));
      }
      // A chapter read from the folder is already there as is; only a merge is new to it.
      const toWrite = result.artifacts.filter(({ kind }) => !pending.fromFolder || kind === "merge");
      if (toWrite.length && (await fsa.hasFolder())) {
        try {
          for (const { artifact } of toWrite) await fsa.writeArtifact(artifact);
        } catch (e) {
          toast(`Imported, but could not write to the folder: ${(e as Error).message}`, "error");
        }
      }
      toast(describeImport(result.summary));
    },
    [toast, touchBooks],
  );

  /** Plan an import; apply it at once unless something needs the user's decision. */
  const importArtifacts = useCallback(
    async (found: Artifact[], label: string, fromFolder: boolean) => {
      if (!found.length) return;
      // Claimed before the first await: `pendingImport` state is only set after planning,
      // so two overlapping calls would both pass a check on it and one plan would be lost.
      if (importBusy.current) {
        toast("Finish or cancel the open import first.", "error");
        return;
      }
      importBusy.current = true;
      let opened = false;
      try {
        const existing = await db.listArtifacts();
        const have = new Set(existing.map(artifactKey));
        const lines = new Map<string, Map<string, number>>();
        for (const key of new Set(found.map(artifactKey))) {
          if (!have.has(key)) continue;
          const rows = await db.getUnitRecords(key);
          lines.set(key, new Map(rows.flatMap((r) => (r.at ? [[r.uid, r.at] as const] : []))));
        }
        const chapters = new Map((await db.listJobs()).map((j) => [j.id, j.updatedAt]));
        const plan = planImport(existing, found, { lines, chapters });
        const pending: PendingImport = { plan, label, fromFolder };
        if (hasDecisions(plan)) {
          setPendingImport(pending);
          opened = true; // released by apply or cancel
        } else {
          await applyImport(pending, defaultChoices(plan));
        }
      } finally {
        if (!opened) importBusy.current = false;
      }
    },
    [applyImport, toast],
  );

  const applyPendingImport = useCallback(
    async (choices: ImportChoices) => {
      if (!pendingImport) return;
      try {
        await applyImport(pendingImport, choices);
      } catch (e) {
        toast(`Import failed: ${(e as Error).message}`, "error");
      }
      setPendingImport(null);
      importBusy.current = false;
    },
    [pendingImport, applyImport, toast],
  );

  const cancelPendingImport = useCallback(() => {
    setPendingImport(null);
    importBusy.current = false;
    toast("Import cancelled — nothing was changed.");
  }, [toast]);

  const addFiles = useCallback(
    async (files: File[]) => {
      const importedArtifacts: Artifact[] = [];
      const artifactFiles: string[] = [];
      const noCharaMeta: string[] = [];
      for (const file of files) {
        const text = await file.text();
        try {
          if (/\.bundle\.json$/i.test(file.name)) {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed)) {
              for (const item of parsed) {
                importedArtifacts.push(parseArtifact(JSON.stringify(item), file.name));
              }
              artifactFiles.push(file.name);
              continue;
            }
          }
          if (/\.tl\.json$/i.test(file.name) || /\.json$/i.test(file.name)) {
            importedArtifacts.push(parseArtifact(text, file.name));
            artifactFiles.push(file.name);
            continue;
          }
          if (isBilingualHtml(file.name, text)) {
            // Not a book: parsing it as one would fuse each unit's two sides into one line.
            const doc = parseBilingualHtml(file.name, text);
            if (!doc.chapters.length) {
              toast(`${file.name} has no chapters — is it a .bilingual.html from this app?`, "error");
              continue;
            }
            setBilingualDocs((prev) => [...prev.filter((d) => d.file !== doc.file), doc]);
            toast(`Loaded ${file.name} for summarizing: ${doc.chapters.length} chapter(s)`);
            continue;
          }
          const book = parseBookHtml(file.name, text);
          if (!book.chapters.length) {
            toast(`${file.name} has no chapters — is it a .book.html from parse.py?`, "error");
            continue;
          }
          if (!book.hasCharaMeta) noCharaMeta.push(file.name);
          const rec: SourceRecord = {
            id: `${file.name}:${hashFile(text)}`,
            file: file.name,
            srcHash: book.srcHash,
            html: text,
            addedAt: Date.now(),
          };
          await db.putSource(rec);
          setSources((prev) => [...prev.filter((p) => p.id !== rec.id), rec]);
          setBooks((prev) => new Map(prev).set(rec.id, book));
          setActiveSource(rec.id);
          toast(`Loaded ${file.name}: ${book.chapters.length} chapter(s)`);
        } catch (e) {
          toast(`${file.name}: ${(e as Error).message}`, "error");
        }
      }

      if (noCharaMeta.length) setMetaWarningFiles(noCharaMeta);

      await importArtifacts(
        importedArtifacts,
        artifactFiles.length === 1 ? artifactFiles[0] : `${artifactFiles.length} files`,
        false,
      );
    },
    [toast, importArtifacts],
  );

  const updateSourceNote = useCallback(async (id: string, note: string) => {
    setSources((prev) => {
      const rec = prev.find((s) => s.id === id);
      if (!rec) return prev;
      const next = { ...rec, note };
      void db.putSource(next);
      return prev.map((s) => (s.id === id ? next : s));
    });
  }, []);

  const setTermExcluded = useCallback(async (id: string, jp: string, excluded: boolean) => {
    setSources((prev) => {
      const rec = prev.find((s) => s.id === id);
      if (!rec) return prev;
      const rest = (rec.excludedTerms ?? []).filter((t) => t !== jp);
      const next = { ...rec, excludedTerms: excluded ? [...rest, jp] : rest };
      void db.putSource(next);
      return prev.map((s) => (s.id === id ? next : s));
    });
  }, []);

  const updateCustomName = useCallback(async (id: string, lang: Lang, display: string, name: string) => {
    setSources((prev) => {
      const rec = prev.find((s) => s.id === id);
      if (!rec) return prev;
      const langMap = { ...(rec.customNames?.[lang] ?? {}) };
      const trimmed = name.trim();
      if (trimmed) langMap[display] = trimmed;
      else delete langMap[display];
      const customNames = { ...rec.customNames, [lang]: langMap };
      const next = { ...rec, customNames };
      void db.putSource(next);
      return prev.map((s) => (s.id === id ? next : s));
    });
  }, []);

  const updateDictionaryName = useCallback(async (lang: Lang, display: string, name: string) => {
    const trimmedDisplay = display.trim();
    const trimmedName = name.trim();
    if (!trimmedDisplay) return;
    setSettings((prev) => {
      const currentDict = prev.dictionary ?? { en: {}, "zh-hans": {}, "zh-hant": {} };
      const langMap = { ...(currentDict[lang] ?? {}) };
      if (trimmedName) {
        langMap[trimmedDisplay] = trimmedName;
      } else {
        delete langMap[trimmedDisplay];
      }
      const nextDict = { ...currentDict, [lang]: langMap };
      const next = { ...prev, dictionary: nextDict };
      void db.saveSettings(next);
      return next;
    });
  }, []);

  const deleteDictionaryName = useCallback(async (lang: Lang, display: string) => {
    setSettings((prev) => {
      const currentDict = prev.dictionary ?? { en: {}, "zh-hans": {}, "zh-hant": {} };
      const langMap = { ...(currentDict[lang] ?? {}) };
      delete langMap[display];
      const nextDict = { ...currentDict, [lang]: langMap };
      const next = { ...prev, dictionary: nextDict };
      void db.saveSettings(next);
      return next;
    });
  }, []);

  const importCustomNamesToDictionary = useCallback(async (): Promise<number> => {
    let addedCount = 0;
    setSettings((prev) => {
      const currentDict = JSON.parse(
        JSON.stringify(prev.dictionary ?? { en: {}, "zh-hans": {}, "zh-hant": {} }),
      ) as Record<Lang, Record<string, string>>;
      for (const src of sources) {
        if (!src.customNames) continue;
        for (const lang of Object.keys(src.customNames) as Lang[]) {
          const names = src.customNames[lang];
          if (!names) continue;
          if (!currentDict[lang]) currentDict[lang] = {};
          for (const [disp, val] of Object.entries(names)) {
            if (val && !currentDict[lang][disp]) {
              currentDict[lang][disp] = val;
              addedCount++;
            }
          }
        }
      }
      const next = { ...prev, dictionary: currentDict };
      void db.saveSettings(next);
      return next;
    });
    return addedCount;
  }, [sources]);

  /** Apply a dictionary plan; a backup writes the folder first, so a failed write changes nothing. */
  const applyDict = useCallback(
    async (p: PendingDict, choices: DictChoices) => {
      const before = settings.dictionary ?? {};
      const after = resolveDict(before, p.plan, choices);
      const change = describeDict(summarizeDict(before, after));
      if (p.plan.mode === "backup") {
        try {
          await fsa.writeDictionary(serializeDictionary(after));
        } catch (e) {
          toast(`Could not write ${fsa.DICTIONARY_FILE}: ${(e as Error).message}`, "error");
          return;
        }
      }
      await saveSettings({ dictionary: after });
      toast(
        p.plan.mode === "backup"
          ? `Backed up the dictionary to ${fsa.DICTIONARY_FILE} in ${p.label} (this browser: ${change}).`
          : `Imported dictionary: ${change}.`,
      );
    },
    [settings.dictionary, saveSettings, toast],
  );

  const importDictionary = useCallback(
    async (data: DictionaryData, label: string) => {
      const plan = planDictImport(settings.dictionary ?? {}, data);
      if (!plan.diffs.length) {
        toast("The dictionary already has every entry in that file.");
        return;
      }
      const pending = { plan, label };
      if (hasDictDecisions(plan)) setPendingDict(pending);
      else await applyDict(pending, defaultDictChoices(plan));
    },
    [settings.dictionary, applyDict, toast],
  );

  const applyPendingDict = useCallback(
    async (choices: DictChoices) => {
      if (!pendingDict) return;
      await applyDict(pendingDict, choices);
      setPendingDict(null);
    },
    [pendingDict, applyDict],
  );

  const cancelPendingDict = useCallback(() => {
    setPendingDict(null);
    toast("Cancelled — the dictionary was not changed.");
  }, [toast]);

  const clearDictionary = useCallback(async (lang: Lang) => {
    setSettings((prev) => {
      const currentDict = { ...(prev.dictionary ?? { en: {}, "zh-hans": {}, "zh-hant": {} }) };
      currentDict[lang] = {};
      const next = { ...prev, dictionary: currentDict };
      void db.saveSettings(next);
      return next;
    });
  }, []);

  const removeSource = useCallback(async (id: string) => {
    await db.deleteSource(id);
    setSources((prev) => prev.filter((s) => s.id !== id));
    setBooks((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    setActiveSource((cur) => (cur === id ? null : cur));
  }, []);

  const refreshJobs = useCallback(async () => setJobs(await db.listJobs()), []);

  const saveArtifact = useCallback(
    async (a: Artifact) => {
      await db.putArtifact(a);
      setArtifacts((prev) => [...prev.filter((x) => artifactKey(x) !== artifactKey(a)), a]);
      touchBooks([a.book]);
      if (await fsa.hasFolder()) {
        try {
          await fsa.writeArtifact(a);
        } catch (e) {
          toast(`Could not write to the folder: ${(e as Error).message}`, "error");
        }
      }
    },
    [toast, touchBooks],
  );

  const removeArtifact = useCallback(async (key: string) => {
    await db.deleteArtifact(key);
    setArtifacts((prev) => prev.filter((a) => artifactKey(a) !== key));
  }, []);

  const freeBook = useCallback(
    async (book: string, lang: Lang) => {
      const base = normalizeBookBase(book);
      const doomedJobs = jobs.filter(
        (j) => normalizeBookBase(j.bookFile) === base && j.lang === lang,
      );
      for (const j of doomedJobs) await db.deleteJob(j.id);
      const doomedArtifacts = artifacts.filter(
        (a) => normalizeBookBase(a.book) === base && a.lang === lang,
      );
      for (const a of doomedArtifacts) await db.deleteArtifact(artifactKey(a));
      setJobs((prev) =>
        prev.filter((j) => !(normalizeBookBase(j.bookFile) === base && j.lang === lang)),
      );
      setArtifacts((prev) =>
        prev.filter((a) => !(normalizeBookBase(a.book) === base && a.lang === lang)),
      );
      toast(`Freed ${book} (${lang}) from the browser database.`);
    },
    [jobs, artifacts, toast],
  );

  const refreshFolderFiles = useCallback(async () => {
    try {
      setFolderFiles(await fsa.listFiles());
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }, [toast]);

  const connectFolder = useCallback(async () => {
    try {
      setFolderName(await fsa.pickFolder());
      toast("Folder connected — finished chapters will be written there automatically.");
      await refreshFolderFiles();
    } catch (e) {
      if ((e as Error).name !== "AbortError") toast((e as Error).message, "error");
    }
  }, [toast, refreshFolderFiles]);

  const backupDictionary = useCallback(async () => {
    if (!(await fsa.hasFolder())) {
      await connectFolder();
      if (!(await fsa.hasFolder())) return; // picker cancelled
    }
    const label = (await fsa.restoreFolderName()) ?? "the folder";
    const mine = settings.dictionary ?? {};
    try {
      const text = await fsa.readDictionaryText();
      let file: DictionaryData = {};
      if (text !== null) {
        try {
          file = parseDictionaryFile(text);
        } catch (e) {
          toast(`${fsa.DICTIONARY_FILE} in ${label} is ${(e as Error).message}, so it was left untouched.`, "error");
          return;
        }
      }
      const plan = planDictBackup(mine, file);
      if (!plan.diffs.length) {
        toast(text === null ? "The dictionary is empty — nothing to back up." : "The backup is already up to date.");
        return;
      }
      const pending = { plan, label };
      if (hasDictDecisions(plan)) setPendingDict(pending);
      else await applyDict(pending, defaultDictChoices(plan));
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }, [connectFolder, settings.dictionary, applyDict, toast]);

  const disconnectFolder = useCallback(async () => {
    await fsa.forgetFolder();
    setFolderName(null);
    setFolderFiles([]);
  }, []);

  const syncFolder = useCallback(async () => {
    try {
      const found = await fsa.readArtifacts();
      if (!found.length) {
        toast("The folder has no .tl.json files.");
        return;
      }
      await importArtifacts(found, `from folder (${found.length} file${found.length === 1 ? "" : "s"})`, true);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }, [toast, importArtifacts]);

  const loadFolderGroup = useCallback(
    async (group: Pick<BookGroup, "book" | "lang" | "artifactFiles" | "sourceFile">) => {
      try {
        let loadedSources = 0;

        if (group.sourceFile && !sources.some((s) => s.file === group.sourceFile)) {
          const html = await fsa.readFile(group.sourceFile);
          const book = parseBookHtml(group.sourceFile, html);
          if (book.chapters.length) {
            const rec: SourceRecord = {
              id: `${group.sourceFile}:${hashFile(html)}`,
              file: group.sourceFile,
              srcHash: book.srcHash,
              html,
              addedAt: Date.now(),
            };
            await db.putSource(rec);
            setSources((prev) => [...prev.filter((p) => p.id !== rec.id), rec]);
            setBooks((prev) => new Map(prev).set(rec.id, book));
            setActiveSource((cur) => cur ?? rec.id);
            loadedSources++;
          }
        }

        if (loadedSources) toast(`Loaded source ${group.sourceFile}.`);

        if (group.artifactFiles.length) {
          const found = await fsa.readArtifactsByNames(group.artifactFiles);
          await importArtifacts(found, `${group.book} (${group.lang}) from folder`, true);
        }
      } catch (e) {
        toast(`Failed to load ${group.book}: ${(e as Error).message}`, "error");
      }
    },
    [sources, toast, importArtifacts],
  );

  const store: Store = {
    ready,
    settings,
    sources,
    jobs,
    artifacts,
    books,
    bilingualDocs,
    view,
    activeSourceId,
    folderName,
    folderFiles,
    toasts,
    pendingImport,
    pendingDict,
    metaWarningFiles,
    reviewKey,
    reviewSelection,
    touchedBooks,
    setView,
    openReview,
    setReviewSelection,
    setActiveSource,
    saveSettings,
    addFiles,
    removeSource,
    updateSourceNote,
    updateCustomName,
    setTermExcluded,
    updateDictionaryName,
    deleteDictionaryName,
    importCustomNamesToDictionary,
    importDictionary,
    backupDictionary,
    clearDictionary,
    refreshJobs,
    saveArtifact,
    removeArtifact,
    connectFolder,
    disconnectFolder,
    syncFolder,
    refreshFolderFiles,
    loadFolderGroup,
    freeBook,
    toast,
    applyPendingImport,
    cancelPendingImport,
    applyPendingDict,
    cancelPendingDict,
    dismissMetaWarning: () => setMetaWarningFiles([]),
    activePreset: () => findPreset(settings.presets, settings.presetId),
    apiKey: (preset) =>
      settings.apiKeys[(preset ?? findPreset(settings.presets, settings.presetId)).baseUrl] ?? "",
    limiterFor: (preset) =>
      new RateLimiter(
        preset.limits,
        preset.quotaResetTz,
        settings.limiter[preset.id] ?? emptyState(),
        (s) => void saveSettings({ limiter: { ...settings.limiter, [preset.id]: s } }),
      ),
    calibrationFor: (model, lang, preset) =>
      settings.calibration[`${model}:${lang}`] ?? {
        charsPerToken: (preset ?? findPreset(settings.presets, settings.presetId)).charsPerToken,
        outputRatio: OUTPUT_RATIO[lang],
        samples: 0,
      },
  };

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

/** The book model for the currently selected source file. */
export function useActiveBook(): { book: Book; source: SourceRecord } | null {
  const { books, sources, activeSourceId } = useStore();
  return useMemo(() => {
    if (!activeSourceId) return null;
    const book = books.get(activeSourceId);
    const source = sources.find((s) => s.id === activeSourceId);
    return book && source ? { book, source } : null;
  }, [books, sources, activeSourceId]);
}
