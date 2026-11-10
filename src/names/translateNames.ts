/**
 * Mass-translate speaker names that have no official translation yet.
 *
 * Not part of the translation pipeline and not the wire format: the model gets a numbered
 * list of Japanese names and answers `<n> <translation>` lines, so the four-file contract
 * in `serialize.ts` / `prompt.ts` / `mock_server.py` is untouched (the mock only has to
 * recognise the request).
 *
 * What makes it worth a model call is context. An unknown `センセチアの母` contains the
 * official `センセチア`, so the request carries that pair and the model returns
 * "Sensettia's Mother" instead of inventing a second spelling. Matching is by substring,
 * longest key first, with the same katakana-boundary rule the glossary uses.
 */
import { estimateTokens } from "../llm/estimate";
import { isCheapPreset, type Preset } from "../llm/presets";
import { PROMPT_LANG_LABEL } from "../llm/prompt";
import { sendRequest, type SendDeps } from "../orchestrator/send";
import { bookSpeakers, countMentions, isValuableTerm } from "../scenario/glossary";
import type { Book, Lang } from "../scenario/model";

/**
 * A name list is a trivial task and the point is to spend the cheap quota, so only
 * presets marked `cheap` may run it. Gemini Flash and custom presets are refused
 * rather than silently swapped.
 */
export function canTranslateNames(preset: Pick<Preset, "id">): boolean {
  return isCheapPreset(preset);
}

/** Names per request. A real book has tens; this only guards an absurd one. */
export const MAX_NAMES_PER_REQUEST = 150;

/** Replies are a few tokens a name; the preset's cap is sized for translating a chapter. */
const MAX_OUTPUT_TOKENS = 4096;

export const NAMES_SYSTEM_PROMPT = `You translate character names and speaker labels from a Japanese narrative game into {{targetLanguage}}.

The user message has two parts: <known_names>, official translations as "日本語 = translation" lines, and <names>, a numbered list of names to translate.

Rules:
- Reply with exactly one line per name: "<number> <translation>", using the same numbers. Nothing else: no Japanese, no explanation, no quotes, no markdown.
- Proper names (people, monsters, places): transliterate them in the style of the known names. {{script}}
- Role or group labels (e.g. 音楽祭スタッフ, 楽団員): translate by meaning.
- When a name contains a known name, reuse that official translation exactly and translate only the rest: with 「メリデ = Melide」, メリデの母 becomes "Melide's Mother".
- Several names may share a base (センセチア変身後, センセチア変身後クロスロード): keep the shared part identical across them.
- Text in parentheses or a sprite/outfit suffix such as 変身後 is part of the name; translate it.
- If a name cannot be translated (already Latin letters), return it unchanged.{{note}}`;

const SCRIPT_HINT: Record<Lang, string> = {
  en: "Write English names in Latin letters; use Title Case for labels.",
  "zh-hans": "Use the conventional Simplified Chinese characters for them.",
  "zh-hant": "Use the conventional Traditional Chinese characters for them.",
};

export function namesSystemPrompt(lang: Lang, note?: string): string {
  const n = note?.trim();
  return NAMES_SYSTEM_PROMPT.replace("{{targetLanguage}}", PROMPT_LANG_LABEL[lang])
    .replace("{{script}}", SCRIPT_HINT[lang])
    .replace("{{note}}", n ? `\n\nNotes from the user about this story:\n${n}` : "");
}

// -- what is already known -----------------------------------------------------

export interface KnownInput {
  book: Book;
  lang: Lang;
  /** Dictionary merged with the file's custom names: what the user has typed. */
  custom?: Record<string, string>;
  /** Keys the user switched off for this file. */
  excluded?: Iterable<string>;
}

/**
 * Every Japanese -> translation pair we already trust: the game's own tables, official
 * speaker names, then the user's entries. A speaker's official name beats the user's, as
 * in `buildGlossary`.
 */
export function knownNames(input: KnownInput): Map<string, string> {
  const { book, lang } = input;
  const out = new Map<string, string>();
  for (const [jp, per] of Object.entries(book.terms ?? {})) {
    const tl = per[lang]?.trim();
    if (tl && isValuableTerm(jp)) out.set(jp, tl);
  }
  const speakerKeys = new Set<string>();
  for (const s of bookSpeakers(book)) {
    const jp = (s.nameText ?? s.jp).trim();
    const tl = s.tl?.[lang]?.trim();
    if (!jp || !tl || !isValuableTerm(jp)) continue;
    out.set(jp, tl);
    speakerKeys.add(jp);
  }
  for (const [raw, v] of Object.entries(input.custom ?? {})) {
    const jp = raw.trim();
    const tl = v.trim();
    if (jp && tl && !speakerKeys.has(jp)) out.set(jp, tl);
  }
  for (const jp of input.excluded ?? []) out.delete(jp);
  return out;
}

/**
 * The known names that sit inside `name`, longest first and without overlap.
 * A name equal to a key is not "inside" itself; callers handle that as an exact hit.
 */
export function containedKnown(name: string, known: Map<string, string>): [string, string][] {
  // One character matches too much (`母` in every relation); two is the glossary's floor too.
  const keys = [...known.keys()].filter((k) => k !== name && [...k].length >= 2 && name.includes(k));
  if (!keys.length) return [];
  const hits = countMentions(keys, [name]);
  return [...hits.keys()].map((k) => [k, known.get(k)!]);
}

// -- plan, send, parse ---------------------------------------------------------

export interface NamesPlan {
  /** Names whose whole text is already a known name: filled without asking the model. */
  exact: Map<string, string>;
  /** Names that need the model. */
  ask: string[];
  /** Known pairs worth sending, for each name that is asked. */
  context: Map<string, [string, string][]>;
}

/** Split `names` into the ones we can answer ourselves and the ones to ask about. */
export function planNames(names: string[], known: Map<string, string>): NamesPlan {
  const exact = new Map<string, string>();
  const ask: string[] = [];
  const context = new Map<string, [string, string][]>();
  for (const name of names) {
    const hit = known.get(name);
    if (hit) {
      exact.set(name, hit);
      continue;
    }
    ask.push(name);
    context.set(name, containedKnown(name, known));
  }
  return { exact, ask, context };
}

/** The user message for one batch. Ids are positions in `names`, 1-based. */
export function namesUserMessage(names: string[], context: Map<string, [string, string][]>): string {
  const pairs = new Map<string, string>();
  for (const n of names) for (const [jp, tl] of context.get(n) ?? []) pairs.set(jp, tl);
  const known = [...pairs].map(([jp, tl]) => `${jp} = ${tl}`).join("\n");
  const list = names.map((n, i) => `${i + 1} ${n}`).join("\n");
  return `<known_names>\n${known || "(none)"}\n</known_names>\n\n<names>\n${list}\n</names>`;
}

// The id must be followed by punctuation or whitespace, so a bare `12` (a blank answer)
// is not read as id 1 with the translation "2".
const LINE = /^\s*(\d+)(?:\s*[.:：)\]、]\s*|\s+)(.+?)\s*$/;

/**
 * Pull `<n> <translation>` lines out of a reply. Tolerates a code fence, bullets, and a
 * model echoing the Japanese back as `1 センセチアの母 = Sensettia's Mother`. A name the
 * reply skipped is absent from the result.
 */
export function parseNamesReply(content: string, names: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of content.split("\n")) {
    const line = raw.replace(/^\s*[-*•]\s+/, "");
    if (/^\s*```/.test(line)) continue;
    const m = LINE.exec(line);
    if (!m) continue;
    const name = names[Number(m[1]) - 1];
    if (name === undefined || out.has(name)) continue;
    let tl = m[2];
    if (tl.startsWith(name)) tl = tl.slice(name.length).replace(/^\s*(?:=|→|->|:|：|-)\s*/, "");
    tl = tl.replace(/^["'`“”「『]+|["'`“”」』]+$/g, "").trim();
    if (tl) out.set(name, tl);
  }
  return out;
}

export interface NamesDeps extends Omit<SendDeps, "onEvent" | "maxOutputTokens"> {
  charsPerToken: number;
  /** The preset's cap; clamped down to what a name list needs. */
  maxOutputTokens: number;
  onEvent?: SendDeps["onEvent"];
}

export interface NamesResult {
  /** Everything to fill in: exact hits and the model's answers. */
  translations: Map<string, string>;
  /** Asked about, but missing from the reply. */
  missing: string[];
  /** How many of `translations` came from a known name rather than the model. */
  exact: number;
  requests: number;
  /** Why the run stopped early, if it did; `translations` still holds what arrived before. */
  error?: Error;
}

/**
 * Translate `names`. Only an abort throws; any other failure ends the run and is returned
 * as `error` next to whatever had already arrived, so the caller can still use that.
 */
export async function translateNames(
  args: { names: string[]; lang: Lang; known: Map<string, string>; note?: string },
  deps: NamesDeps,
  signal: AbortSignal,
): Promise<NamesResult> {
  const plan = planNames(args.names, args.known);
  const translations = new Map(plan.exact);
  const missing: string[] = [];
  const system = namesSystemPrompt(args.lang, args.note);
  let requests = 0;
  let error: Error | undefined;

  const batches: string[][] = [];
  for (let i = 0; i < plan.ask.length; i += MAX_NAMES_PER_REQUEST) {
    batches.push(plan.ask.slice(i, i + MAX_NAMES_PER_REQUEST));
  }

  for (const [bi, batch] of batches.entries()) {
    const user = namesUserMessage(batch, plan.context);
    try {
      const res = await sendRequest({
        system,
        user,
        estimate: estimateTokens(system + user, deps.charsPerToken),
        index: bi,
        deps: {
          ...deps,
          maxOutputTokens: Math.min(deps.maxOutputTokens, MAX_OUTPUT_TOKENS),
          onEvent: deps.onEvent ?? (() => {}),
        },
        signal,
      });
      requests++;
      const got = parseNamesReply(res.content, batch);
      for (const n of batch) {
        const tl = got.get(n);
        if (tl) translations.set(n, tl);
        else missing.push(n);
      }
    } catch (e) {
      if (signal.aborted) throw e;
      // `sendRequest` has already retried what is retryable, so the next batch would
      // most likely meet the same fate: stop, and hand back what arrived.
      error = e as Error;
      for (const rest of batches.slice(bi)) missing.push(...rest);
      break;
    }
  }
  return { translations, missing, exact: plan.exact.size, requests, error };
}
