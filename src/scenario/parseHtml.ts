/**
 * Scrapes a `.book.html` into the {@link Book} model.
 *
 * `parse.py` writes one element per line as a flat sibling under `<body>`, with two
 * exceptions the HTML parser repairs for us: the `<ol>` table of contents, and
 * `div.cond-block`, which is opened at `If` and closed at `EndIf` so everything
 * between them ends up nested. We therefore walk the tree, not the lines.
 *
 * Files produced by `parse.py --tl_meta` carry extra `data-*` attributes; they are
 * used when present and inferred from the visible text when not, so already
 * generated files keep working.
 */
import { toCompact } from "./inline";
import { hash8, hashFile, LANGS, type Book, type Chapter, type Lang, type SceneNode, type Speaker } from "./model";

/** `火のテンジン (通常):` -> name + pose. The pose is absent under `--tl_name`. */
const CHARA_TEXT = /^(.*?)(?:\s*\((.*)\))?\s*[:：]\s*$/;

const META_LANG_ATTR: Record<Lang, string> = {
  en: "data-chara-en",
  "zh-hans": "data-chara-zh-hans",
  "zh-hant": "data-chara-zh-hant",
};

/** One entry of the `#chara-meta` dictionary parse.py embeds: id -> official names. */
interface CharaMetaEntry {
  chara: string;
  en?: string;
  "zh-hans"?: string;
  "zh-hant"?: string;
}

/** Reads the consolidated `<script id="chara-meta">` dict, if present. */
function readCharaMeta(doc: Document): { map: Record<string, CharaMetaEntry>; present: boolean } {
  const script = doc.getElementById("chara-meta");
  if (!script?.textContent) return { map: {}, present: false };
  try {
    return { map: JSON.parse(script.textContent), present: true };
  } catch {
    return { map: {}, present: false };
  }
}

export function parseBookHtml(file: string, html: string): Book {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const chapters: Chapter[] = [];
  const hasMeta = doc.body.hasAttribute("data-parse-version");
  const { map: charaMeta, present: hasCharaMeta } = readCharaMeta(doc);

  let chapter: Chapter | null = null;
  let label = "";
  let n = 0;

  const push = (node: SceneNode) => {
    if (!chapter) return;
    chapter.nodes.push(node);
  };

  const uid = () => `${label || chapter!.name}/${++n}`;

  const walk = (parent: Element) => {
    for (const el of Array.from(parent.children)) {
      const tag = el.tagName.toLowerCase();
      const cls = el.className;

      if (tag === "h3") {
        chapter = { name: el.id || el.textContent?.trim() || `chapter${chapters.length}`, nodes: [], units: 0, chars: 0 };
        chapters.push(chapter);
        label = "";
        n = 0;
        continue;
      }

      if (!chapter) continue; // control fieldset, TOC, style tags before the first chapter

      if (cls === "cond-block") {
        const expr = el.querySelector(":scope > .cond code")?.textContent?.trim() ?? "";
        push({ kind: "cond", expr });
        walk(el);
        push({ kind: "cond-end" });
        continue;
      }

      switch (cls) {
        case "label": {
          label = el.id;
          n = 0;
          push({ kind: "label", id: el.id });
          break;
        }
        case "text": {
          const speaker = readSpeaker(el, charaMeta);
          const { text, sizes } = toCompact(el, (c) => {
            const k = c.className;
            return k === "chara" || k.includes("voice");
          });
          // Sprite/pose rows carry a speaker but no line — nothing to translate.
          if (!text) break;
          chapter.units++;
          chapter.chars += text.length;
          push({ kind: "text", uid: uid(), speaker, src: text, hash: hash8(text), ...(sizes.length ? { sizes } : {}) });
          break;
        }
        case "select": {
          const a = el.querySelector("a");
          const { text, sizes } = toCompact(a ?? el);
          const to = el.getAttribute("data-to") ?? a?.getAttribute("href")?.slice(1) ?? "";
          const cond = el.getAttribute("data-if") ?? undefined;
          const exec = el.getAttribute("data-do") ?? undefined;
          if (!text) break;
          chapter.units++;
          chapter.chars += text.length;
          push({
            kind: "select",
            uid: uid(),
            src: text,
            hash: hash8(text),
            to,
            ...(cond ? { cond } : {}),
            ...(exec ? { exec } : {}),
            ...(sizes.length ? { sizes } : {}),
          });
          break;
        }
        case "jump": {
          const a = el.querySelector("a");
          const to = el.getAttribute("data-to") ?? a?.getAttribute("href")?.slice(1) ?? "";
          const random = el.hasAttribute("data-random") || (el.textContent ?? "").includes("50%");
          const note = el.textContent?.match(/\((.*)\)\s*$/)?.[1];
          push({ kind: "jump", to, ...(random ? { random } : {}), ...(note ? { note } : {}) });
          break;
        }
        case "title": {
          const text = (el.textContent ?? "").trim();
          if (!text) break;
          chapter.units++;
          chapter.chars += text.length;
          push({ kind: "title", uid: uid(), src: text, hash: hash8(text) });
          break;
        }
        default:
          break; // p (Background/BGM/Set), ol, fieldset, script — dropped
      }
    }
  };

  walk(doc.body);
  return { file, srcHash: hashFile(html), chapters, hasMeta, hasCharaMeta };
}

function readSpeaker(el: Element, charaMeta: Record<string, CharaMetaEntry>): Speaker | undefined {
  const span = el.querySelector(".chara");
  const charaId = el.getAttribute("data-chara-id");
  const meta = charaId ? charaMeta[charaId] : undefined;
  const metaName = meta?.chara ?? el.getAttribute("data-chara");
  if (!span && !metaName) return undefined;

  const raw = (span?.textContent ?? "").trim();
  const m = CHARA_TEXT.exec(raw);
  const jp = metaName ?? m?.[1]?.trim() ?? raw.replace(/[:：]\s*$/, "");
  const pose = el.getAttribute("data-pose") ?? m?.[2]?.trim();

  const tl: Partial<Record<Lang, string>> = {};
  if (meta) {
    for (const lang of LANGS) {
      const v = meta[lang];
      if (v) tl[lang] = v;
    }
  } else {
    for (const [lang, attr] of Object.entries(META_LANG_ATTR) as [Lang, string][]) {
      const v = el.getAttribute(attr);
      if (v) tl[lang] = v;
    }
  }

  return {
    jp,
    ...(pose ? { pose } : {}),
    ...(Object.keys(tl).length ? { tl } : {}),
  };
}

/** Distinct speakers in a chapter, in first-appearance order — the glossary source. */
export function chapterSpeakers(chapter: Chapter): Speaker[] {
  const seen = new Map<string, Speaker>();
  for (const node of chapter.nodes) {
    if (node.kind !== "text" || !node.speaker) continue;
    const prev = seen.get(node.speaker.jp);
    // Prefer whichever occurrence carries official translations.
    if (!prev || (!prev.tl && node.speaker.tl)) seen.set(node.speaker.jp, node.speaker);
  }
  return Array.from(seen.values());
}
