/**
 * Application state and every side effect that touches storage.
 *
 * Views read from here and call actions; nothing else talks to IndexedDB or the
 * filesystem directly. Kept as one context rather than a state library because the
 * whole app is four screens over five object stores.
 */
import { createContext } from "preact";
import { useCallback, useContext, useEffect, useMemo, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { findPreset, type Preset } from "../llm/presets";
import type { Calibration } from "../llm/estimate";
import { OUTPUT_RATIO } from "../llm/estimate";
import * as db from "../storage/db";
import type { Settings, SourceRecord } from "../storage/db";
import {
  artifactKey,
  mergeArtifacts,
  parseArtifact,
  type Artifact,
  type MergeConflict,
} from "../storage/exchange";
import * as fsa from "../storage/fsa";
import { hashFile, type Book, type Lang } from "../scenario/model";
import { parseBookHtml } from "../scenario/parseHtml";
import type { Job } from "../orchestrator/job";

export type View = "scan" | "translate" | "library" | "settings";

export interface Toast {
  id: number;
  kind: "info" | "error";
  message: string;
}

export interface Store {
  ready: boolean;
  settings: Settings;
  sources: SourceRecord[];
  jobs: Job[];
  artifacts: Artifact[];
  books: Map<string, Book>;
  view: View;
  activeSourceId: string | null;
  folderName: string | null;
  toasts: Toast[];
  conflicts: MergeConflict[];
  /** Filenames just uploaded that lack the consolidated `#chara-meta` JSON dict. */
  metaWarningFiles: string[];

  setView(v: View): void;
  setActiveSource(id: string | null): void;
  saveSettings(patch: Partial<Settings>): Promise<void>;
  addFiles(files: File[]): Promise<void>;
  removeSource(id: string): Promise<void>;
  refreshJobs(): Promise<void>;
  saveArtifact(a: Artifact): Promise<void>;
  removeArtifact(key: string): Promise<void>;
  connectFolder(): Promise<void>;
  disconnectFolder(): Promise<void>;
  syncFolder(): Promise<void>;
  toast(message: string, kind?: Toast["kind"]): void;
  dismissConflicts(): void;
  dismissMetaWarning(): void;
  activePreset(): Preset;
  apiKey(): string;
  calibrationFor(model: string, lang: Lang): Calibration;
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
  const [view, setView] = useState<View>("scan");
  const [activeSourceId, setActiveSource] = useState<string | null>(null);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [conflicts, setConflicts] = useState<MergeConflict[]>([]);
  const [metaWarningFiles, setMetaWarningFiles] = useState<string[]>([]);

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

  const addFiles = useCallback(
    async (files: File[]) => {
      const importedArtifacts: Artifact[] = [];
      const noCharaMeta: string[] = [];
      for (const file of files) {
        const text = await file.text();
        try {
          if (/\.tl\.json$/i.test(file.name) || /\.json$/i.test(file.name)) {
            importedArtifacts.push(parseArtifact(text, file.name));
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

      if (importedArtifacts.length) {
        const existing = await db.listArtifacts();
        const { artifacts: merged, conflicts: found } = mergeArtifacts([
          ...existing,
          ...importedArtifacts,
        ]);
        for (const a of merged) await db.putArtifact(a);
        setArtifacts(merged);
        setConflicts(found);
        toast(`Imported ${importedArtifacts.length} translation file(s)`);
      }
    },
    [toast],
  );

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
      if (await fsa.hasFolder()) {
        try {
          await fsa.writeArtifact(a);
        } catch (e) {
          toast(`Could not write to the folder: ${(e as Error).message}`, "error");
        }
      }
    },
    [toast],
  );

  const removeArtifact = useCallback(async (key: string) => {
    await db.deleteArtifact(key);
    setArtifacts((prev) => prev.filter((a) => artifactKey(a) !== key));
  }, []);

  const connectFolder = useCallback(async () => {
    try {
      setFolderName(await fsa.pickFolder());
      toast("Folder connected — finished chapters will be written there automatically.");
    } catch (e) {
      if ((e as Error).name !== "AbortError") toast((e as Error).message, "error");
    }
  }, [toast]);

  const disconnectFolder = useCallback(async () => {
    await fsa.forgetFolder();
    setFolderName(null);
  }, []);

  const syncFolder = useCallback(async () => {
    try {
      const found = await fsa.readArtifacts();
      const existing = await db.listArtifacts();
      const { artifacts: merged, conflicts: found2 } = mergeArtifacts([...existing, ...found]);
      for (const a of merged) await db.putArtifact(a);
      setArtifacts(merged);
      setConflicts(found2);
      toast(`Folder holds ${found.length} translation file(s)`);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }, [toast]);

  const store: Store = {
    ready,
    settings,
    sources,
    jobs,
    artifacts,
    books,
    view,
    activeSourceId,
    folderName,
    toasts,
    conflicts,
    metaWarningFiles,
    setView,
    setActiveSource,
    saveSettings,
    addFiles,
    removeSource,
    refreshJobs,
    saveArtifact,
    removeArtifact,
    connectFolder,
    disconnectFolder,
    syncFolder,
    toast,
    dismissConflicts: () => setConflicts([]),
    dismissMetaWarning: () => setMetaWarningFiles([]),
    activePreset: () => findPreset(settings.presets, settings.presetId),
    apiKey: () => settings.apiKeys[findPreset(settings.presets, settings.presetId).baseUrl] ?? "",
    calibrationFor: (model, lang) =>
      settings.calibration[`${model}:${lang}`] ?? {
        charsPerToken: findPreset(settings.presets, settings.presetId).charsPerToken,
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
