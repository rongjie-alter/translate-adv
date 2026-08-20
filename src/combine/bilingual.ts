/**
 * Combines translated chapters into one readable file.
 *
 * The output deliberately mirrors what `parse.py` produces — same colours, same
 * sticky chapter headings, same label/jump anchors — because that is what readers
 * are already used to navigating. The translation reads as the primary text with
 * the Japanese underneath, and a checkbox hides the Japanese for a clean read,
 * following the existing `hide-br` / `hide-ruby` control idiom.
 *
 * Input is artifacts only: whoever assembles the file needs no `.book.html` and no
 * API key.
 */
import { escapeHtml, renderCompact } from "../scenario/inline";
import { LANG_LABEL, type Lang } from "../scenario/model";
import { speakerName } from "../scenario/serialize";
import type { Artifact, ArtifactMarker, ArtifactUnit } from "../storage/exchange";
import { normalizeBookBase } from "../storage/groups";

export interface CombineOptions {
  book: string;
  lang: Lang;
  artifacts: Artifact[];
  /** Chapter names known to exist in the book, in order — drives the gap list. */
  chapterOrder?: string[];
  generatedAt?: number;
}

export function combineBilingual(opts: CombineOptions): string {
  const chapters = orderChapters(opts);
  const missing = (opts.chapterOrder ?? []).filter(
    (name) => !chapters.some((a) => a.chapter === name),
  );
  const title = `${opts.book} — ${LANG_LABEL[opts.lang]}`;

  const body: string[] = [];
  body.push(header(title));
  body.push(toc(chapters, missing, opts));
  for (const a of chapters) body.push(renderChapter(a, opts.lang));
  body.push(FOOTER);
  return body.join("\n");
}

function orderChapters(opts: CombineOptions): Artifact[] {
  const base = normalizeBookBase(opts.book);
  const mine = opts.artifacts.filter(
    (a) => normalizeBookBase(a.book) === base && a.lang === opts.lang,
  );
  const order = opts.chapterOrder;
  if (!order) return [...mine].sort((a, b) => a.chapter.localeCompare(b.chapter));
  return [...mine].sort((a, b) => {
    const ai = order.indexOf(a.chapter);
    const bi = order.indexOf(b.chapter);
    if (ai === -1 && bi === -1) return a.chapter.localeCompare(b.chapter);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

function toc(chapters: Artifact[], missing: string[], opts: CombineOptions): string {
  const out: string[] = ["<h2>" + escapeHtml(opts.book) + "</h2>", "<ol>"];
  for (const a of chapters) {
    const gaps = a.incomplete?.length ?? 0;
    const note = gaps ? ` <span class="gap">${gaps} line(s) untranslated</span>` : "";
    out.push(
      `<li><a href="#${attr(a.chapter)}">${escapeHtml(a.chapter)}</a> ` +
        `(${a.units.length} lines, ${escapeHtml(a.model)})${note}</li>`,
    );
  }
  out.push("</ol>");
  if (missing.length) {
    out.push(
      `<p class="gap">Not translated yet: ${missing.map(escapeHtml).join(", ")}</p>`,
    );
  }
  const at = opts.generatedAt ? new Date(opts.generatedAt).toISOString().slice(0, 16).replace("T", " ") : "";
  if (at) out.push(`<p class="meta">Combined ${escapeHtml(at)}</p>`);
  return out.join("\n");
}

function renderChapter(a: Artifact, lang: Lang): string {
  const out: string[] = [`<h3 id="${attr(a.chapter)}">${escapeHtml(a.chapter)}</h3>`];
  const markers = groupMarkers(a.markers);
  let depth = 0;

  const emitMarkers = (at: number) => {
    for (const m of markers.get(at) ?? []) {
      switch (m.kind) {
        case "label":
          out.push(`<div class="label" id="${attr(m.id ?? "")}">Label: ${escapeHtml(m.id ?? "")}</div>`);
          break;
        case "jump":
          out.push(
            `<div class="jump">${m.random ? "50% chance of jumping to" : "Jump to"} ` +
              `<a href="#${attr(m.to ?? "")}">${escapeHtml(m.to ?? "")}</a></div>`,
          );
          break;
        case "cond":
          depth++;
          out.push(`<div class="cond-block"><div class="cond"><code>If ${escapeHtml(m.expr ?? "")}</code></div>`);
          break;
        case "cond-end":
          if (depth > 0) {
            depth--;
            out.push("</div>");
          }
          break;
      }
    }
  };

  a.units.forEach((u, i) => {
    emitMarkers(i);
    out.push(renderUnit(u, lang));
  });
  emitMarkers(a.units.length);
  while (depth-- > 0) out.push("</div>");
  return out.join("\n");
}

function groupMarkers(markers: ArtifactMarker[]): Map<number, ArtifactMarker[]> {
  const map = new Map<number, ArtifactMarker[]>();
  for (const m of markers) {
    const list = map.get(m.at);
    if (list) list.push(m);
    else map.set(m.at, [m]);
  }
  return map;
}

function renderUnit(u: ArtifactUnit, lang: Lang): string {
  const chara = u.speaker
    ? `<span class="chara">${escapeHtml(speakerName(u.speaker, lang))}` +
      `${u.speaker.pose ? ` (${escapeHtml(u.speaker.pose)})` : ""}:</span> `
    : "";
  const jpChara = u.speaker ? `<span class="chara">${escapeHtml(u.speaker.jp)}:</span> ` : "";

  const tl = u.tl
    ? renderCompact(u.tl, { ruby: false, sizes: u.sizes })
    : `<span class="gap">[not translated]</span>`;
  const src = renderCompact(u.src, { sizes: u.sizes });

  const cls = u.kind === "select" ? "select" : u.kind === "title" ? "title" : "text";
  const open = u.kind === "select" ? `<div class="select" id="opt-${attr(u.id)}">` : `<div class="${cls}">`;
  const to = u.to ? ` <a class="to" href="#${attr(u.to)}">→ ${escapeHtml(u.to)}</a>` : "";

  return (
    `${open}<div class="tl">${chara}${tl}${to}</div>` +
    `<div class="jp">${jpChara}${src}</div></div>`
  );
}

function attr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

function header(title: string): string {
  return `<!DOCTYPE html><html lang="en">
<meta content="text/html;charset=utf-8" http-equiv="Content-Type">
<title>${escapeHtml(title)}</title>
<style>
body { font-family: system-ui, sans-serif; margin: 0 auto; max-width: 60em; padding: 1em 5em 4em 1em; }
h3 { top: 0; position: sticky; background: #7986CB; padding: 5px; margin: 1.5em 0 0; }
.select { background: #8888ff; }
.select .tl, .select .jp { color: #fff; }
.select a { color: #fff; }
.jump { background: #88ff88; }
.label { background: #ffff88; }
.label:target { background: #ff8888; }
.chara { font-weight: 900; }
.text { background: #f5f5f5; }
.title { background: #88ffff; }
.select, .jump, .label, .text, .title { margin: 10px 0; padding: 10px; }
.jp { color: #555; font-size: 0.9em; margin-top: 0.4em; }
.select .jp { color: #e8e8ff; }
.hide-jp .jp { display: none; }
.hide-ruby rt { display: none; }
.gap { color: #b00; font-style: italic; }
.meta { color: #777; font-size: 0.85em; }
.to { font-size: 0.85em; opacity: 0.85; }
.cond-block { margin-inline: 2px; padding: 0.35em 0.75em 0.625em; border: 2px groove threedface; }
em { text-emphasis: circle; -webkit-text-emphasis: circle; font-style: normal; }
.control { position: fixed; top: 15px; right: 10px; background: #fff; }
</style>
<body>
<fieldset class="control">
<legend>Control</legend>
<div><input type="checkbox" id="jp-btn"><label for="jp-btn">Hide Japanese</label></div>
<div><input type="checkbox" id="ruby-btn"><label for="ruby-btn">Hide ruby text</label></div>
</fieldset>`;
}

const FOOTER = `<script>
document.querySelector("#jp-btn").onclick = function() {
  document.body.classList.toggle("hide-jp");
};
document.querySelector("#ruby-btn").onclick = function() {
  document.body.classList.toggle("hide-ruby");
};
</script></body></html>`;

/** File name for the combined output. */
export function combinedFileName(book: string, lang: Lang): string {
  const base = normalizeBookBase(book);
  return `${base}.${lang}.bilingual.html`;
}
