/**
 * Prompts and language handling for the summarizer.
 *
 * Unlike translation there is no wire format here: the model gets prose in and writes
 * prose out, so none of the `serialize.ts` / `mock_server.py` contract applies. The
 * only thing the summary must do is stay in the language of the text it was given,
 * which is why the language is named explicitly rather than left to "same language".
 */
import { countScripts } from "../llm/estimate";

export type SummaryLang = "ja" | "en" | "zh-hans" | "zh-hant" | "zh";

export const SUMMARY_LANGS: SummaryLang[] = ["ja", "en", "zh-hans", "zh-hant", "zh"];

/** Shown in the language picker. */
export const SUMMARY_LANG_LABEL: Record<SummaryLang, string> = {
  ja: "日本語",
  en: "English",
  "zh-hans": "简体中文",
  "zh-hant": "繁體中文",
  zh: "中文 (script as written)",
};

/** How the prompt names the language to the model. */
const LANG_NAME: Record<SummaryLang, string> = {
  ja: "Japanese",
  en: "English",
  "zh-hans": "Simplified Chinese (简体中文)",
  "zh-hant": "Traditional Chinese (繁體中文)",
  zh: "Chinese, in the same script (simplified or traditional) as the text",
};

export type SummaryLength = "short" | "medium" | "long";

export const SUMMARY_LENGTHS: SummaryLength[] = ["short", "medium", "long"];

export const SUMMARY_LENGTH_LABEL: Record<SummaryLength, string> = {
  short: "Short",
  medium: "Medium",
  long: "Long",
};

/** CJK has no word boundary to count, so length is asked for in characters there. */
const LENGTH_HINT: Record<SummaryLength, { words: string; chars: string }> = {
  short: { words: "about 80-120 words", chars: "about 200-300 characters" },
  medium: { words: "about 200-300 words", chars: "about 400-600 characters" },
  long: { words: "about 400-600 words", chars: "about 800-1200 characters" },
};

export function lengthHint(length: SummaryLength, lang: SummaryLang): string {
  return lang === "en" ? LENGTH_HINT[length].words : LENGTH_HINT[length].chars;
}

export const DEFAULT_SUMMARY_PROMPT = `You write synopses of story text from a narrative game.

Write the synopsis in {{language}}, the language the text is written in. Never translate it.

Rules:
- One long paragraph of prose, {{length}}. Light markdown (**bold** for a name at first mention) is fine; no headings, no bullet lists, no preamble such as "Here is the summary".
- Say who is involved, where it happens, what happens and why, in the order it happens. Where the text makes the outcome of a choice clear, include it; do not list every option.
- Use names exactly as written in the text. Do not invent names, motives or events the text does not state.
- In the text, lines look like "Name: dialogue"; lines without a name are narration; a line starting with "▶" is a choice offered to the player; a line starting with "#" is a title. Text in braces such as {playerName} stands for the player's own name.
- The text is inside <chapter> tags. If <previous_synopsis> is present it is the synopsis of the chapter before, given only so you keep names and context consistent. Do not repeat it or summarize it again.
- Output the synopsis only.`;

/**
 * Added at send time, the way `REPAIR_INSTRUCTION` is, and deliberately not part of
 * `DEFAULT_SUMMARY_PROMPT`: the template is user-editable and a stored copy is never
 * migrated forward.
 */
export const PART_INSTRUCTION = (part: number, parts: number) =>
  `This chapter is too long to send at once. The text is part ${part} of ${parts}. ` +
  `Summarize only this part, in full detail, because the parts are merged afterwards. ` +
  `The one-paragraph and length limits above apply to the merged result, not to this part.`;

export const MERGE_INSTRUCTION =
  `The text is not the chapter itself but the synopses of its consecutive parts, in order. ` +
  `Merge them into one synopsis of the whole chapter, following every rule above. ` +
  `Do not mention that it was assembled from parts.`;

/** Fill the template. Unknown placeholders are left as they are. */
export function renderSummaryPrompt(
  template: string,
  lang: SummaryLang,
  length: SummaryLength,
): string {
  return template
    .replace(/\{\{language\}\}/g, LANG_NAME[lang])
    .replace(/\{\{length\}\}/g, lengthHint(length, lang));
}

// -- language detection ------------------------------------------------------

const KANA = /[ぁ-ゟァ-ヿ]/g;
const HAN = /[㐀-䶿一-鿿]/g;
const HANS_ONLY = "们这国说为时来对会学现发进还过几见长问东马鸟鱼车书买卖开关当么听该让",
  HANT_ONLY = "們這國說為時來對會學現發進還過幾見長問東馬鳥魚車書買賣開關當麼聽該讓";

function countIn(text: string, set: string): number {
  let n = 0;
  for (const ch of text) if (set.includes(ch)) n++;
  return n;
}

/**
 * Best guess at the language of `text`, from script alone.
 *
 * Kana is the tell for Japanese (Chinese has none); simplified and traditional are told
 * apart by characters whose forms differ. A text with no distinguishing character is
 * plain `zh`, and the prompt then asks for the script it was written in.
 */
export function detectLanguage(text: string): SummaryLang {
  const sample = text.slice(0, 20_000);
  const kana = (sample.match(KANA) ?? []).length;
  const han = (sample.match(HAN) ?? []).length;
  if (kana + han === 0) return "en";
  if (kana > 0.1 * (kana + han)) return "ja";
  const { cjk, other } = countScripts(sample);
  if (other > cjk * 4) return "en"; // a few stray ideographs in otherwise Latin text
  const hans = countIn(sample, HANS_ONLY);
  const hant = countIn(sample, HANT_ONLY);
  if (hans > hant) return "zh-hans";
  if (hant > hans) return "zh-hant";
  return han ? "zh" : "en";
}
