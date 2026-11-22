/**
 * Planning an import of translation files into the browser database.
 *
 * Pure, so the interesting part is testable without IndexedDB or a DOM. The store
 * builds a plan, applies it straight away when nothing needs a decision, and
 * otherwise hands it to `ImportConflictDialog`; `resolveImport` turns the plan plus
 * the user's choices into the artifacts and unit rows to write.
 *
 * Lines are merged one by one, unlike `mergeArtifacts`, which keeps one whole
 * chapter. That only works while both sides were made from the same source: unit
 * ids `{label}/{n}` are stable for one `.book.html`, not across versions of it, so
 * a source-hash mismatch is a whole-chapter choice instead.
 */
import { cleanUnits } from "../scenario/cleanup";
import type { Lang, Speaker } from "../scenario/model";
import { artifactKey, pick, type Artifact, type ArtifactUnit } from "./exchange";

export type Side = "mine" | "incoming";

export interface LineConflict {
  uid: string;
  src: string;
  speaker?: Speaker;
  mine: string;
  incoming: string;
  /** Best guess at when the browser's line was written; see `planImport`. */
  mineAt: number;
  /** The incoming file's `generatedAt`: no per-line time travels in a `.tl.json`. */
  incomingAt: number;
  suggested: Side;
}

export interface ChapterPlan {
  key: string;
  book: string;
  chapter: string;
  lang: Lang;
  /**
   * - `new`: not in the browser yet; imported whole.
   * - `identical`: nothing to change (lines may differ only by an echoed name).
   * - `merge`: same source; `fills` apply on their own, `conflicts` need a choice.
   * - `version-mismatch`: made from a different `.book.html`; one side wins whole.
   */
  kind: "new" | "identical" | "merge" | "version-mismatch";
  mine?: Artifact;
  incoming: Artifact;
  /** Lines empty in the browser and translated in the file. */
  fills: { uid: string; text: string }[];
  conflicts: LineConflict[];
  /** Only for `version-mismatch`. */
  suggested?: Side;
}

export interface ImportChoices {
  /** `key` → `uid` → side, for `merge` chapters. */
  lines: Record<string, Record<string, Side>>;
  /** `key` → side, for `version-mismatch` chapters. */
  chapters: Record<string, Side>;
}

/**
 * What the browser knows about when its lines were written.
 *
 * `lines` comes from `UnitRecord.at`, which manual edits, retranslation, find &
 * replace and imports stamp. Lines written by a translation run carry no time, so
 * `chapters` (the job's `updatedAt`) stands in, and failing that the artifact's own
 * `generatedAt`.
 */
export interface MineTimes {
  lines: Map<string, Map<string, number>>;
  chapters: Map<string, number>;
}

export function planImport(
  existing: Artifact[],
  incoming: Artifact[],
  times: MineTimes = { lines: new Map(), chapters: new Map() },
): ChapterPlan[] {
  const mine = new Map(existing.map((a) => [artifactKey(a), a]));

  // Two files of the same chapter in one import: keep the better one, as before.
  const reduced = new Map<string, Artifact>();
  for (const a of incoming) {
    const key = artifactKey(a);
    const prev = reduced.get(key);
    reduced.set(key, prev ? pick(prev, a)[0] : a);
  }

  const plans: ChapterPlan[] = [];
  for (const [key, inc] of reduced) {
    const base = { key, book: inc.book, chapter: inc.chapter, lang: inc.lang, incoming: inc };
    const own = mine.get(key);
    if (!own) {
      plans.push({ ...base, kind: "new", fills: [], conflicts: [] });
      continue;
    }
    // A missing hash (an older or hand-made file) proves nothing about the version, and
    // matching lines by id across versions would splice unrelated lines together.
    if (!own.srcHash || !inc.srcHash || own.srcHash !== inc.srcHash) {
      plans.push({
        ...base,
        kind: "version-mismatch",
        mine: own,
        fills: [],
        conflicts: [],
        // Keep mine, unless mine holds nothing worth keeping.
        suggested: filledCount(own) === 0 && filledCount(inc) > 0 ? "incoming" : "mine",
      });
      continue;
    }

    const lineTimes = times.lines.get(key);
    const fallback = times.chapters.get(key) ?? own.generatedAt;
    const ownClean = byId(cleanUnits(own.units));
    const incRaw = byId(inc.units);
    const incClean = byId(cleanUnits(inc.units));
    const fills: ChapterPlan["fills"] = [];
    const conflicts: LineConflict[] = [];

    for (const u of own.units) {
      const theirs = incRaw.get(u.id);
      if (!theirs?.tl) continue; // nothing incoming: keep mine, whatever it is
      if (!u.tl) {
        fills.push({ uid: u.id, text: theirs.tl });
        continue;
      }
      if (u.tl === theirs.tl) continue;
      // Differs only by a `Name：` or `>alias` echo that Clean up would strip.
      if (ownClean.get(u.id)?.tl === incClean.get(u.id)?.tl) continue;
      const mineAt = lineTimes?.get(u.id) ?? fallback;
      conflicts.push({
        uid: u.id,
        src: u.src,
        ...(u.speaker ? { speaker: u.speaker } : {}),
        mine: u.tl,
        incoming: theirs.tl,
        mineAt,
        incomingAt: inc.generatedAt,
        suggested: inc.generatedAt > mineAt ? "incoming" : "mine",
      });
    }

    plans.push({
      ...base,
      kind: fills.length || conflicts.length ? "merge" : "identical",
      mine: own,
      fills,
      conflicts,
    });
  }
  return plans;
}

/** True when the dialog has something to ask; otherwise the plan applies as is. */
export function hasDecisions(plan: ChapterPlan[]): boolean {
  return plan.some((c) => c.kind === "version-mismatch" || c.conflicts.length > 0);
}

export function defaultChoices(plan: ChapterPlan[]): ImportChoices {
  const choices: ImportChoices = { lines: {}, chapters: {} };
  for (const c of plan) {
    if (c.kind === "version-mismatch") choices.chapters[c.key] = c.suggested ?? "mine";
    if (c.conflicts.length) {
      choices.lines[c.key] = Object.fromEntries(c.conflicts.map((l) => [l.uid, l.suggested]));
    }
  }
  return choices;
}

/** Every decision set to one side; used by "Keep all mine" / "Take all incoming". */
export function allChoices(plan: ChapterPlan[], side: Side): ImportChoices {
  const choices: ImportChoices = { lines: {}, chapters: {} };
  for (const c of plan) {
    if (c.kind === "version-mismatch") choices.chapters[c.key] = side;
    if (c.conflicts.length) {
      choices.lines[c.key] = Object.fromEntries(c.conflicts.map((l) => [l.uid, side]));
    }
  }
  return choices;
}

export interface UnitWrite {
  key: string;
  texts: Map<string, string>;
  /**
   * What the browser's artifact held for each replaced line. A line that only ever
   * lived in the artifact has no `units` row, so `keepPrevious` would have nothing
   * to keep; the store seeds a row from this first.
   */
  previous: Map<string, string>;
  model: string;
  at: number;
}

export interface ImportSummary {
  newChapters: number;
  replacedChapters: number;
  identicalChapters: number;
  filledLines: number;
  takenLines: number;
  keptLines: number;
  keptChapters: number;
}

export interface ImportResult {
  /** Only artifacts that changed, with the kind of change. */
  artifacts: { artifact: Artifact; kind: ChapterPlan["kind"] }[];
  /** Rows for the `units` store, so replaced lines can be reverted in Review. */
  unitWrites: UnitWrite[];
  summary: ImportSummary;
}

export function resolveImport(plan: ChapterPlan[], choices: ImportChoices, now: number): ImportResult {
  const artifacts: ImportResult["artifacts"] = [];
  const unitWrites: UnitWrite[] = [];
  const summary: ImportSummary = {
    newChapters: 0,
    replacedChapters: 0,
    identicalChapters: 0,
    filledLines: 0,
    takenLines: 0,
    keptLines: 0,
    keptChapters: 0,
  };

  for (const c of plan) {
    if (c.kind === "new") {
      artifacts.push({ artifact: c.incoming, kind: c.kind });
      summary.newChapters++;
      continue;
    }
    if (c.kind === "identical") {
      summary.identicalChapters++;
      continue;
    }
    if (c.kind === "version-mismatch") {
      if ((choices.chapters[c.key] ?? c.suggested ?? "mine") === "incoming") {
        artifacts.push({ artifact: c.incoming, kind: c.kind });
        summary.replacedChapters++;
      } else {
        summary.keptChapters++;
      }
      continue;
    }

    const mine = c.mine!;
    const picked = choices.lines[c.key] ?? {};
    const taken = new Map<string, string>(c.fills.map((f) => [f.uid, f.text]));
    summary.filledLines += c.fills.length;
    for (const l of c.conflicts) {
      if ((picked[l.uid] ?? l.suggested) === "incoming") {
        taken.set(l.uid, l.incoming);
        summary.takenLines++;
      } else {
        summary.keptLines++;
      }
    }
    if (!taken.size) continue;

    const incUnits = byId(c.incoming.units);
    const lineModel = (uid: string) => incUnits.get(uid)?.model || c.incoming.model;
    // Not `now`: lines this import leaves alone fall back to the artifact's time when they
    // have no `UnitRecord.at`, and they are no newer than either side.
    const at = Math.max(mine.generatedAt || 0, c.incoming.generatedAt || 0) || now;
    artifacts.push({ artifact: patchArtifact(mine, taken, lineModel, at), kind: c.kind });

    // One putUnits call per model, since it stamps one model on every row it writes.
    const byModel = new Map<string, Map<string, string>>();
    for (const [uid, text] of taken) {
      const m = lineModel(uid);
      byModel.set(m, (byModel.get(m) ?? new Map()).set(uid, text));
    }
    const mineUnits = byId(mine.units);
    for (const [model, texts] of byModel) {
      const previous = new Map<string, string>();
      for (const uid of texts.keys()) {
        const was = mineUnits.get(uid)?.tl;
        if (was) previous.set(uid, was);
      }
      unitWrites.push({ key: c.key, texts, previous, model, at: c.incoming.generatedAt || now });
    }
  }

  return { artifacts, unitWrites, summary };
}

/** One line for the toast after an import. */
export function describeImport(s: ImportSummary): string {
  const parts: string[] = [];
  if (s.newChapters) parts.push(`${s.newChapters} new chapter${plural(s.newChapters)}`);
  if (s.replacedChapters) parts.push(`${s.replacedChapters} chapter${plural(s.replacedChapters)} replaced`);
  if (s.filledLines) parts.push(`${s.filledLines} line${plural(s.filledLines)} filled in`);
  if (s.takenLines) parts.push(`${s.takenLines} line${plural(s.takenLines)} updated`);
  if (s.keptLines) parts.push(`${s.keptLines} line${plural(s.keptLines)} kept`);
  if (s.keptChapters) parts.push(`${s.keptChapters} chapter${plural(s.keptChapters)} kept`);
  if (!parts.length) {
    return s.identicalChapters
      ? `Already up to date: ${s.identicalChapters} chapter${plural(s.identicalChapters)} identical.`
      : "Nothing to import.";
  }
  if (s.identicalChapters) parts.push(`${s.identicalChapters} unchanged`);
  return `Imported: ${parts.join(", ")}.`;
}

/**
 * Write `taken` into `mine`, giving each line the model it came from.
 *
 * Like `applyTranslations`, but that function stamps one model on every line it
 * touches, and lines from a shared file can each carry their own.
 */
function patchArtifact(
  mine: Artifact,
  taken: Map<string, string>,
  lineModel: (uid: string) => string,
  at: number,
): Artifact {
  const units = mine.units.map((u) => {
    const tl = taken.get(u.id);
    if (tl === undefined) return u;
    const { model: _drop, ...rest } = u;
    const model = lineModel(u.id);
    return { ...rest, tl, ...(model && model !== mine.model ? { model } : {}) };
  });
  const incomplete = units.filter((u) => !u.tl).map((u) => u.id);
  const { incomplete: _was, ...rest } = mine;
  return { ...rest, units, generatedAt: at, ...(incomplete.length ? { incomplete } : {}) };
}

export function filledCount(a: Artifact): number {
  return a.units.filter((u) => u.tl).length;
}

function byId(units: ArtifactUnit[]): Map<string, ArtifactUnit> {
  return new Map(units.map((u) => [u.id, u]));
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}
