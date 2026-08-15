/**
 * The `.tl.json` exchange artifact.
 *
 * This is the unit of sharing: several people each translate different chapters to
 * spread the free-tier cost, then swap files. An artifact is identified by
 * **input filename + chapter + language**, and carries its own source text and
 * branch structure, so combining never needs the original `.book.html` — whoever
 * assembles the final file may not have translated any of it themselves.
 *
 * API keys are never written here.
 */
import type { Chapter, Lang, SceneNode, Speaker } from "../scenario/model";
import { isTranslatable } from "../scenario/model";

export const ARTIFACT_VERSION = 1;

export interface ArtifactUnit {
  id: string;
  kind: "text" | "select" | "title";
  /** Japanese source, in the compact inline form. */
  src: string;
  /** Translation. Empty when the model never returned this line. */
  tl: string;
  hash: string;
  speaker?: Speaker;
  /** Branch target, for `select` units. */
  to?: string;
  sizes?: number[];
  /**
   * Set only when this line came from a different model than the chapter's.
   * Additive and ignorable, so it does not move `ARTIFACT_VERSION` — an older
   * build reading a newer file simply skips it.
   */
  model?: string;
}

/** Structure between units, so the combined file can rebuild branch navigation. */
export interface ArtifactMarker {
  /** Index in `units` this marker sits before. */
  at: number;
  kind: "label" | "jump" | "cond" | "cond-end";
  id?: string;
  to?: string;
  expr?: string;
  random?: boolean;
}

export interface Artifact {
  v: number;
  book: string;
  srcHash: string;
  chapter: string;
  lang: Lang;
  model: string;
  generatedAt: number;
  units: ArtifactUnit[];
  markers: ArtifactMarker[];
  /** Units the endpoint never returned; shown as gaps rather than hidden. */
  incomplete?: string[];
}

export function buildArtifact(args: {
  book: string;
  srcHash: string;
  chapter: Chapter;
  lang: Lang;
  model: string;
  translations: Map<string, string>;
  generatedAt: number;
}): Artifact {
  const units: ArtifactUnit[] = [];
  const markers: ArtifactMarker[] = [];

  for (const node of args.chapter.nodes) {
    if (isTranslatable(node)) {
      units.push(toUnit(node, args.translations.get(node.uid) ?? ""));
    } else {
      markers.push(toMarker(node, units.length));
    }
  }

  const incomplete = units.filter((u) => !u.tl).map((u) => u.id);
  return {
    v: ARTIFACT_VERSION,
    book: args.book,
    srcHash: args.srcHash,
    chapter: args.chapter.name,
    lang: args.lang,
    model: args.model,
    generatedAt: args.generatedAt,
    units,
    markers,
    ...(incomplete.length ? { incomplete } : {}),
  };
}

function toUnit(node: Extract<SceneNode, { uid: string }>, tl: string): ArtifactUnit {
  return {
    id: node.uid,
    kind: node.kind,
    src: node.src,
    tl,
    hash: node.hash,
    ...(node.kind === "text" && node.speaker ? { speaker: node.speaker } : {}),
    ...(node.kind === "select" ? { to: node.to } : {}),
    ...("sizes" in node && node.sizes ? { sizes: node.sizes } : {}),
  };
}

function toMarker(node: SceneNode, at: number): ArtifactMarker {
  switch (node.kind) {
    case "label":
      return { at, kind: "label", id: node.id };
    case "jump":
      return { at, kind: "jump", to: node.to, ...(node.random ? { random: true } : {}) };
    case "cond":
      return { at, kind: "cond", expr: node.expr };
    default:
      return { at, kind: "cond-end" };
  }
}

/**
 * Rebuild the node list this artifact was serialized from.
 *
 * An artifact carries everything the wire format needs — kind, src, speaker, `to`,
 * and the structure markers — which is what lets a targeted retranslation work on
 * a `.tl.json` from someone else with no `.book.html` in hand. `SelectNode.cond`,
 * `.exec` and `JumpNode.note` are not carried, and are never sent to the model
 * anyway.
 */
export function artifactNodes(a: Artifact): SceneNode[] {
  const byIndex = new Map<number, ArtifactMarker[]>();
  for (const m of a.markers) {
    const at = byIndex.get(m.at);
    if (at) at.push(m);
    else byIndex.set(m.at, [m]);
  }

  const nodes: SceneNode[] = [];
  const emitMarkers = (at: number) => {
    for (const m of byIndex.get(at) ?? []) nodes.push(fromMarker(m));
  };

  a.units.forEach((u, i) => {
    emitMarkers(i);
    nodes.push(fromUnit(u));
  });
  emitMarkers(a.units.length);
  return nodes;
}

function fromUnit(u: ArtifactUnit): SceneNode {
  const sizes = u.sizes?.length ? { sizes: u.sizes } : {};
  if (u.kind === "select") {
    return { kind: "select", uid: u.id, src: u.src, hash: u.hash, to: u.to ?? "", ...sizes };
  }
  if (u.kind === "title") return { kind: "title", uid: u.id, src: u.src, hash: u.hash };
  return {
    kind: "text",
    uid: u.id,
    src: u.src,
    hash: u.hash,
    ...(u.speaker ? { speaker: u.speaker } : {}),
    ...sizes,
  };
}

function fromMarker(m: ArtifactMarker): SceneNode {
  switch (m.kind) {
    case "label":
      return { kind: "label", id: m.id ?? "" };
    case "jump":
      return { kind: "jump", to: m.to ?? "", ...(m.random ? { random: true } : {}) };
    case "cond":
      return { kind: "cond", expr: m.expr ?? "" };
    default:
      return { kind: "cond-end" };
  }
}

/** Every label id the wire format may need an alias for. */
export function artifactLabelIds(a: Artifact): string[] {
  const ids: string[] = [];
  for (const m of a.markers) {
    if (m.kind === "label" && m.id) ids.push(m.id);
    else if (m.kind === "jump" && m.to) ids.push(m.to);
  }
  for (const u of a.units) if (u.kind === "select" && u.to) ids.push(u.to);
  return ids;
}

/** Distinct speakers in first-appearance order — the glossary source, from an artifact. */
export function artifactSpeakers(a: Artifact): Speaker[] {
  const seen = new Map<string, Speaker>();
  for (const u of a.units) {
    if (u.speaker && !seen.has(u.speaker.jp)) seen.set(u.speaker.jp, u.speaker);
  }
  return [...seen.values()];
}

/**
 * Patch translations into an artifact, in place rather than rebuilding.
 *
 * `buildArtifact` needs the source `Chapter`, which may not exist for an imported
 * file — and rebuilding would drop anything the artifact carries that a local
 * chapter does not. `Artifact.model` is deliberately left alone: it names the model
 * that produced the bulk of the chapter, and per-line exceptions ride on
 * `units[].model` instead, which keeps the combined file's provenance line honest.
 */
export function applyTranslations(
  a: Artifact,
  translations: Map<string, string>,
  meta: { model: string; at: number },
): Artifact {
  const units = a.units.map((u) => {
    const tl = translations.get(u.id);
    if (tl === undefined) return u;
    const { model: _drop, ...rest } = u;
    return { ...rest, tl, ...(meta.model && meta.model !== a.model ? { model: meta.model } : {}) };
  });

  const incomplete = units.filter((u) => !u.tl).map((u) => u.id);
  const { incomplete: _was, ...rest } = a;
  return {
    ...rest,
    units,
    generatedAt: meta.at,
    ...(incomplete.length ? { incomplete } : {}),
  };
}

/** Conventional file name, and the natural key for the designated folder. */
export function artifactFileName(a: Pick<Artifact, "book" | "chapter" | "lang">): string {
  const base = a.book.replace(/\.book\.html$/i, "").replace(/\.html$/i, "");
  return `${base}.${a.chapter}.${a.lang}.tl.json`;
}

export function artifactKey(a: Pick<Artifact, "book" | "chapter" | "lang">): string {
  return `${a.book}::${a.chapter}::${a.lang}`;
}

export class ArtifactError extends Error {}

export function parseArtifact(text: string, fileName = "file"): Artifact {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new ArtifactError(`${fileName} is not valid JSON: ${(e as Error).message}`);
  }
  const a = json as Partial<Artifact>;
  if (!a || typeof a !== "object" || !Array.isArray(a.units)) {
    throw new ArtifactError(`${fileName} is not a translation file`);
  }
  if (!a.book || !a.chapter || !a.lang) {
    throw new ArtifactError(`${fileName} is missing book, chapter or language`);
  }
  if ((a.v ?? 0) > ARTIFACT_VERSION) {
    throw new ArtifactError(
      `${fileName} was written by a newer version of this app (v${a.v}); update before importing.`,
    );
  }
  return {
    v: a.v ?? ARTIFACT_VERSION,
    book: a.book,
    srcHash: a.srcHash ?? "",
    chapter: a.chapter,
    lang: a.lang,
    model: a.model ?? "",
    generatedAt: a.generatedAt ?? 0,
    units: a.units.map(sanitizeUnit),
    markers: a.markers ?? [],
    ...(a.incomplete ? { incomplete: a.incomplete } : {}),
  };
}

/**
 * These files come from other people. `sizes` ends up interpolated into a `style`
 * attribute by `renderCompact`, so anything non-numeric is dropped here rather than
 * trusted downstream.
 */
function sanitizeUnit(u: ArtifactUnit): ArtifactUnit {
  if (!Array.isArray(u.sizes)) return u;
  const sizes = u.sizes.map(Number).filter((n) => Number.isFinite(n) && n > 0);
  return sizes.length === u.sizes.length ? u : { ...u, sizes };
}

export function serializeArtifact(a: Artifact): string {
  return JSON.stringify(a, null, 1);
}

export interface MergeConflict {
  key: string;
  chapter: string;
  lang: Lang;
  kept: Artifact;
  dropped: Artifact;
  /** Set when the two were translated from different versions of the source file. */
  differentSource: boolean;
}

export interface MergeResult {
  artifacts: Artifact[];
  conflicts: MergeConflict[];
}

/**
 * Merge artifacts from several contributors.
 *
 * One artifact wins per book+chapter+language — the newest, which is the only
 * ordering everyone can agree on offline. A conflict is reported rather than
 * silently resolved so the user can override, and a source-hash mismatch is called
 * out because that means the two people scanned different versions of the book.
 */
export function mergeArtifacts(incoming: Artifact[]): MergeResult {
  const best = new Map<string, Artifact>();
  const conflicts: MergeConflict[] = [];

  for (const a of incoming) {
    const key = artifactKey(a);
    const prev = best.get(key);
    if (!prev) {
      best.set(key, a);
      continue;
    }
    const [kept, dropped] = pick(prev, a);
    best.set(key, kept);
    conflicts.push({
      key,
      chapter: a.chapter,
      lang: a.lang,
      kept,
      dropped,
      differentSource: !!prev.srcHash && !!a.srcHash && prev.srcHash !== a.srcHash,
    });
  }

  return { artifacts: [...best.values()], conflicts };
}

/** Prefer the more complete artifact; break ties by recency. */
function pick(a: Artifact, b: Artifact): [Artifact, Artifact] {
  const fa = filled(a);
  const fb = filled(b);
  if (fa !== fb) return fa > fb ? [a, b] : [b, a];
  return a.generatedAt >= b.generatedAt ? [a, b] : [b, a];
}

function filled(a: Artifact): number {
  return a.units.filter((u) => u.tl).length;
}
