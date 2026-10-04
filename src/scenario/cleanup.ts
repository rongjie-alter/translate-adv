/**
 * Mechanical clean-up of model output.
 *
 * Models echo wire-format furniture back — the `>alias` of a branch option, or the
 * `Name:` of a speaker — however firmly the prompt forbids it, and each stored echo
 * is fed back as `~` context, which teaches the next chunk to do it too. So the
 * prompt does not fight it; these functions strip it afterwards. Two entry points:
 *
 * - `stripSelectMarker` / `stripSpeakerPrefix`, applied to each line as it is parsed
 *   (`parseResponse`), where the exact alias and the speaker's names are known;
 * - `cleanUnits`, applied to a whole artifact (imports, and exports of older stored
 *   rows), which repairs files written before this existed.
 *
 * Everything here must be idempotent: clean text goes through it again on every
 * import, so it may only remove a prefix it has real grounds to call an echo.
 */
import type { Speaker } from "./model";

/** A speaker name can itself contain a colon (`SYSTEM：DEUS`), so look this far in. */
const MAX_NAME = 40;
/** The longest echoed name `stripSpeakerPrefix` will take on trust, without a match. */
const MAX_LOOSE_NAME = 24;
const COLON = /[:：]/;
/** Characters that mean a "prefix" is really the start of a sentence, not a name. */
const SENTENCE_PUNCT = /[。，、！…「」『』,.!]/;
/** A source line that itself opens `X：` — its translation may legitimately too. */
const NAME_LEAD = /^[^:：]{1,24}[:：]/;

/** Width, case and spacing folded away: `ＣＥＯ？` and `CEO?` compare equal. */
const fold = (s: string) => s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
const bare = (s: string) => fold(s).replace(/[\p{P}\p{S}]+/gu, "");

/** Every name a speaker might be echoed under, in any language. */
export function speakerNames(s: Speaker): string[] {
  const names = [s.jp, s.nameText, ...Object.values(s.tl ?? {})];
  return names.filter((n): n is string => !!n?.trim());
}

function sameName(prefix: string, names: string[]): boolean {
  const f = fold(prefix);
  const b = bare(prefix);
  return names.some((n) => fold(n) === f || (b !== "" && bare(n) === b));
}

/** True when the source line opens with a `name：` of its own. */
export function srcLeadsWithName(src: string): boolean {
  return NAME_LEAD.test(src);
}

/**
 * Drop a leading `>alias` from a branch option.
 *
 * `alias` is the label alias the wire line carried, when the caller knows it. The
 * model does not always copy it exactly (the prompt's own example reads `>alt1`), so
 * any leading ASCII token after the `>` goes too. A `>` is never part of a real
 * option's text, so this cannot eat a legitimate translation.
 */
export function stripSelectMarker(text: string, alias?: string): string {
  const t = text.trimStart();
  if (!t.startsWith(">")) return text;
  let rest = t.slice(1);
  if (alias && rest.startsWith(alias) && !/[\w.-]/.test(rest[alias.length] ?? "")) {
    rest = rest.slice(alias.length);
  } else {
    rest = rest.replace(/^[\w.-]+(?=\s|[^\x00-\x7f]|$)/, "");
  }
  return rest.trimStart();
}

export interface SpeakerStripOptions {
  /**
   * Also take an unrecognised `name：` prefix on trust. Right at parse time, where
   * the model may have translated the name however it liked; wrong on re-import,
   * where the text is mostly already clean and `Listen: …` could be real dialogue.
   */
  loose?: boolean;
  /** Folded prefixes already known to be echoes of this speaker. */
  learned?: ReadonlySet<string>;
}

/** Index of the colon that ends a leading speaker name, or -1. */
function nameEnd(t: string, names: string[], learned?: ReadonlySet<string>): number {
  let colons = 0;
  for (let i = 1; i <= MAX_NAME && i < t.length; i++) {
    if (!COLON.test(t[i])) continue;
    const prefix = t.slice(0, i);
    if (sameName(prefix, names) || learned?.has(fold(prefix))) return i;
    if (++colons >= 3) break;
  }
  return -1;
}

/** The prefix up to the first colon, if it could plausibly be a name; else null. */
function loosePrefix(t: string): string | null {
  const i = t.search(COLON);
  if (i < 1 || i > MAX_LOOSE_NAME) return null;
  const prefix = t.slice(0, i);
  return SENTENCE_PUNCT.test(prefix) ? null : prefix;
}

/**
 * Drop a leading `Name：` from a speaker's line.
 *
 * Tries each colon against the speaker's known names first, so a name that contains
 * a colon is removed whole. Never strips down to nothing.
 */
export function stripSpeakerPrefix(
  text: string,
  names: string[],
  opts: SpeakerStripOptions = {},
): string {
  const t = text.trimStart();
  let end = nameEnd(t, names, opts.learned);
  if (end < 0 && opts.loose) end = loosePrefix(t)?.length ?? -1;
  if (end < 0) return text;
  const rest = t.slice(end + 1).trimStart();
  return rest || text;
}

/** The slice of an artifact unit that clean-up needs. */
interface Cleanable {
  kind: "text" | "select" | "title";
  src: string;
  tl: string;
  speaker?: Speaker;
}

/**
 * Repair a whole chapter's worth of already-stored translations.
 *
 * A speaker's name is stripped when it matches one the artifact records for them.
 * That misses names the model invented — it renders `職員` as `职员` — so a prefix
 * that opens a majority of one speaker's lines, and at least two, is learned as that
 * speaker's echoed name too. Real dialogue does not open with the same `word：` over
 * and over.
 */
export function cleanUnits<T extends Cleanable>(units: T[]): T[] {
  const out = units.map((u) => {
    if (!u.tl) return u;
    if (u.kind === "select") return withTl(u, stripSelectMarker(u.tl) || u.tl);
    if (u.kind !== "text" || !u.speaker) return u;
    // The speaker's own name is safe to remove whatever the source looks like.
    return withTl(u, stripSpeakerPrefix(u.tl, speakerNames(u.speaker)));
  });

  // Prefixes the known-name pass could not place, counted per speaker.
  const lines = new Map<string, number>();
  const prefixes = new Map<string, Map<string, number>>();
  for (const u of out) {
    if (u.kind !== "text" || !u.speaker || !u.tl || srcLeadsWithName(u.src)) continue;
    const key = u.speaker.jp;
    lines.set(key, (lines.get(key) ?? 0) + 1);
    const prefix = loosePrefix(u.tl.trimStart());
    if (!prefix || sameName(prefix, speakerNames(u.speaker))) continue;
    const counts = prefixes.get(key) ?? new Map<string, number>();
    counts.set(fold(prefix), (counts.get(fold(prefix)) ?? 0) + 1);
    prefixes.set(key, counts);
  }

  const learned = new Map<string, Set<string>>();
  for (const [key, counts] of prefixes) {
    for (const [prefix, n] of counts) {
      if (n >= 2 && n * 2 >= (lines.get(key) ?? 0)) {
        learned.set(key, (learned.get(key) ?? new Set()).add(prefix));
      }
    }
  }
  if (!learned.size) return out;

  return out.map((u) => {
    const set = u.speaker && u.kind === "text" ? learned.get(u.speaker.jp) : undefined;
    if (!set || !u.tl || srcLeadsWithName(u.src)) return u;
    return withTl(u, stripSpeakerPrefix(u.tl, [], { learned: set }));
  });
}

function withTl<T extends { tl: string }>(u: T, tl: string): T {
  return tl === u.tl ? u : { ...u, tl };
}
