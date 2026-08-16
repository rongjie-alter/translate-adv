/**
 * The system prompt.
 *
 * Editable in Settings; `{{targetLanguage}}` and `{{glossary}}` are substituted at
 * send time. The wire-format rules are load-bearing — if the model stops emitting
 * `<id> <text>` the whole chunk has to be repaired or retried — so they are stated
 * up front and repeated as the last line, which is where instruction-following is
 * strongest.
 */
import { LANG_LABEL, type Lang, type Speaker } from "../scenario/model";
import { speakerName } from "../scenario/serialize";

export const DEFAULT_SYSTEM_PROMPT = `You are translating a Japanese visual-novel scenario into {{targetLanguage}}.

Input format — one line per unit:
  12 Name: dialogue        a spoken line; "Name" is the speaker, for context only
  13 narration             a line with no speaker
  14 >alt1 option text     a branch option the player can pick
  15 # Episode - Title     an episode title card
  == label ==              start of a branch; not content
  => label                 a jump to another branch; not content
  ? cond / ?end            a conditional block; not content
  ~ text                   already-translated context; not content

Inline markers, which must survive unchanged into your output:
  {playerName}   a placeholder the game fills in at runtime — never translate or reword it
  漢字(かんじ)   a reading gloss: かんじ is how 漢字 is read aloud. If the reading is just a
                pronunciation aid, translate 漢字 and drop the reading. But if the reading is
                a distinct word/name whose meaning differs from 漢字's literal meaning (e.g.
                理想郷(まほら): kanji literally "utopia", read as the name "Mahora"),
                translate both — e.g. "the storied utopia (Mahora)" — never drop one half for the other
  *text*   emphasis dots in the original
  ^text^   an oversized shout

Translate naturally rather than literally. Keep each speaker's register consistent —
casual stays casual, archaic stays archaic. Preserve honorifics when they carry meaning.
Keep bracketed stage directions like （飛び起きる） in their brackets.
{{glossary}}
Output rules:
- One line per input line, in the same order, each starting with the same number.
- Output the number and the translated text only. No speaker names, no >alt1 or # markers,
  no ==, =>, ?, ~ lines, no commentary, no code fences.
- Never merge, split, skip or reorder lines. If a line is untranslatable, repeat it verbatim.`;

export function buildSystemPrompt(template: string, lang: Lang, speakers: Speaker[]): string {
  return template
    .replace(/\{\{targetLanguage\}\}/g, LANG_LABEL[lang])
    .replace(/\{\{glossary\}\}/g, glossaryBlock(speakers, lang));
}

/**
 * Character names, sent once per chunk instead of being re-derived per line.
 * Names sourced from `common.chapter.json` (via `parse.py --tl_meta`) are marked as
 * official so the model does not "improve" them.
 */
export function glossaryBlock(speakers: Speaker[], lang: Lang): string {
  if (!speakers.length) return "";
  const seen = new Set<string>();
  const official: string[] = [];
  const rest: string[] = [];
  for (const s of speakers) {
    const display = s.nameText ?? s.jp;
    if (seen.has(display)) continue;
    seen.add(display);
    if (s.tl?.[lang]) official.push(`  ${display} = ${speakerName(s, lang)}`);
    else rest.push(`  ${display}`);
  }

  const parts: string[] = [];
  if (official.length) {
    parts.push("\nUse these official character names exactly:\n" + official.join("\n"));
  }
  if (rest.length) {
    parts.push(
      "\nCharacters in this scene (translate their names consistently throughout):\n" +
        rest.join("\n"),
    );
  }
  return parts.join("\n") + "\n";
}

export const REPAIR_INSTRUCTION =
  "Some lines were missing from your last reply. Translate exactly these lines, " +
  "using the same numbers and the same output rules.";

/**
 * Appended at send time for a targeted retranslation, the same way
 * `REPAIR_INSTRUCTION` is — deliberately *not* part of `DEFAULT_SYSTEM_PROMPT`,
 * because that template is user-editable and `loadSettings` never migrates a
 * stored copy forward.
 */
export const RETRANSLATE_INSTRUCTION =
  "These lines have already been translated once and are being redone because the " +
  "previous translation was not good enough. The `~` lines are surrounding context: " +
  "read them for tone, names and continuity, but never output them. `~ [...]` marks a " +
  "jump to a different part of the scene. Translate only the numbered lines, following " +
  "the same output rules.";

/** A user's free-text note for one retranslation, as a system-prompt block. */
export function hintBlock(hint: string): string {
  const trimmed = hint.trim();
  return trimmed ? `\n\nAdditional instructions for these lines:\n${trimmed}` : "";
}
