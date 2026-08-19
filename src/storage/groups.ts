/**
 * Scan folder files and merge with database records into BookGroups.
 */
import { LANGS, type Lang } from "../scenario/model";
import type { SourceRecord } from "./db";
import type { Artifact } from "./exchange";

export interface BookGroup {
  /** Display book name / source file name (e.g. "touroumatsuri2026.book.html") */
  book: string;
  /** Language for this translation group */
  lang: Lang;
  /** True if this group is present in the browser database */
  inDb: boolean;
  /** Loaded artifacts from DB (empty if not in DB) */
  artifacts: Artifact[];
  /** All files belonging to this group in the connected folder */
  folderFiles: string[];
  /** Translation artifact files (.tl.json, .bundle.json) in the folder */
  artifactFiles: string[];
  /** Source book HTML file in the folder if present */
  sourceFile?: string;
}

export function normalizeBookBase(book: string): string {
  return book.replace(/\.book\.html$/i, "").replace(/\.html$/i, "");
}

interface ParsedFile {
  type: "artifact" | "bundle" | "bilingual" | "source" | "unknown";
  bookBase: string;
  chapter?: string;
  lang?: Lang;
  fileName: string;
}

export function parseFolderFileName(fileName: string): ParsedFile {
  const tlMatch = fileName.match(/^(.*)\.([^.]+)\.([a-zA-Z0-9_-]+)\.tl\.json$/i);
  if (tlMatch) {
    return {
      type: "artifact",
      bookBase: normalizeBookBase(tlMatch[1]),
      chapter: tlMatch[2],
      lang: normalizeLang(tlMatch[3]),
      fileName,
    };
  }

  const bundleMatch = fileName.match(/^(.*)\.([a-zA-Z0-9_-]+)\.bundle\.json$/i);
  if (bundleMatch) {
    return {
      type: "bundle",
      bookBase: normalizeBookBase(bundleMatch[1].replace(/\.book$/i, "")),
      lang: normalizeLang(bundleMatch[2]),
      fileName,
    };
  }

  const biMatch = fileName.match(/^(.*)\.([a-zA-Z0-9_-]+)\.bilingual\.html$/i);
  if (biMatch) {
    return {
      type: "bilingual",
      bookBase: normalizeBookBase(biMatch[1]),
      lang: normalizeLang(biMatch[2]),
      fileName,
    };
  }

  if (/\.html$/i.test(fileName) && !/\.bilingual\.html$/i.test(fileName)) {
    return {
      type: "source",
      bookBase: normalizeBookBase(fileName),
      fileName,
    };
  }

  return {
    type: "unknown",
    bookBase: "",
    fileName,
  };
}

function normalizeLang(raw: string): Lang {
  const lower = raw.toLowerCase();
  for (const l of LANGS) {
    if (l.toLowerCase() === lower) return l;
  }
  return lower as Lang;
}

export function scanBookGroups(
  folderFiles: string[],
  dbArtifacts: Artifact[],
  dbSources: SourceRecord[] = [],
): BookGroup[] {
  // Known source book HTML filenames mapped by bookBase
  const sourceNameByBase = new Map<string, string>();
  for (const src of dbSources) {
    sourceNameByBase.set(normalizeBookBase(src.file), src.file);
  }
  for (const f of folderFiles) {
    const p = parseFolderFileName(f);
    if (p.type === "source") {
      sourceNameByBase.set(p.bookBase, f);
    }
  }

  interface GroupAcc {
    bookBase: string;
    book: string;
    lang: Lang;
    artifacts: Artifact[];
    folderFiles: Set<string>;
    artifactFiles: Set<string>;
    sourceFile?: string;
  }

  const groups = new Map<string, GroupAcc>();

  const getOrCreate = (bookBase: string, lang: Lang, explicitBookName?: string): GroupAcc => {
    const key = `${bookBase}::${lang}`;
    let g = groups.get(key);
    if (!g) {
      const book =
        explicitBookName ||
        sourceNameByBase.get(bookBase) ||
        (bookBase.endsWith(".book.html") ? bookBase : `${bookBase}.book.html`);
      g = {
        bookBase,
        book,
        lang,
        artifacts: [],
        folderFiles: new Set(),
        artifactFiles: new Set(),
      };
      groups.set(key, g);
    }
    return g;
  };

  // 1. Ingest DB artifacts
  for (const a of dbArtifacts) {
    const base = normalizeBookBase(a.book);
    const g = getOrCreate(base, a.lang, a.book);
    g.artifacts.push(a);
  }

  // 2. Ingest folder files
  for (const f of folderFiles) {
    const p = parseFolderFileName(f);
    if (p.type === "artifact" && p.lang) {
      const g = getOrCreate(p.bookBase, p.lang);
      g.folderFiles.add(f);
      g.artifactFiles.add(f);
    } else if (p.type === "bundle" && p.lang) {
      const g = getOrCreate(p.bookBase, p.lang);
      g.folderFiles.add(f);
      g.artifactFiles.add(f);
    } else if (p.type === "bilingual" && p.lang) {
      const g = getOrCreate(p.bookBase, p.lang);
      g.folderFiles.add(f);
    } else if (p.type === "source") {
      // If groups exist for this bookBase, associate sourceFile and folderFile with them
      let matched = false;
      for (const g of groups.values()) {
        if (g.bookBase === p.bookBase) {
          g.sourceFile = f;
          g.folderFiles.add(f);
          matched = true;
        }
      }
      // If no translation group exists yet, we don't force a lang group unless needed
      if (!matched) {
        const defaultLang: Lang = "en";
        const g = getOrCreate(p.bookBase, defaultLang, f);
        g.sourceFile = f;
        g.folderFiles.add(f);
      }
    }
  }

  const result: BookGroup[] = [];

  for (const g of groups.values()) {
    g.artifacts.sort((x, y) => x.chapter.localeCompare(y.chapter));
    const inDb = g.artifacts.length > 0;
    result.push({
      book: g.book,
      lang: g.lang,
      inDb,
      artifacts: g.artifacts,
      folderFiles: [...g.folderFiles].sort(),
      artifactFiles: [...g.artifactFiles].sort(),
      ...(g.sourceFile ? { sourceFile: g.sourceFile } : {}),
    });
  }

  return result.sort((a, b) => {
    const cmp = a.book.localeCompare(b.book);
    return cmp !== 0 ? cmp : a.lang.localeCompare(b.lang);
  });
}
