/**
 * Conversion between the inline markup `parse.py` emits and a compact plain-text
 * form that is cheap to send to an LLM and survives a round trip.
 *
 *   <ruby>平<rp>(</rp><rt>たいら</rt><rp>)</rp></ruby>   ->  平(たいら)
 *   <code>&lt;param=playerName&gt;</code>                ->  {playerName}
 *   <em>許婚</em>                                        ->  *許婚*
 *   <span style="font-size: calc(45px * 0.5)">…</span>   ->  ^…^
 *   <br>                                                 ->  (dropped)
 */

const PARAM_TEXT = /^<param=(.+)>$/;
const SIZE_STYLE = /font-size:\s*calc\((\d+)px/;

export interface InlineResult {
  text: string;
  /** Pixel sizes of the `^…^` runs, in order, so rendering can restore them. */
  sizes: number[];
}

/**
 * Flatten an element's children into compact text.
 *
 * `skip` lets the caller exclude nodes it has already consumed (the `span.chara`
 * speaker prefix and the `span.voice` id, which is dropped entirely).
 */
export function toCompact(el: Element, skip?: (child: Element) => boolean): InlineResult {
  const sizes: number[] = [];
  const out: string[] = [];

  const walk = (node: Node) => {
    if (node.nodeType === 3 /* TEXT_NODE */) {
      out.push(node.nodeValue ?? "");
      return;
    }
    if (node.nodeType !== 1 /* ELEMENT_NODE */) return;

    const e = node as Element;
    if (skip?.(e)) return;

    const tag = e.tagName.toLowerCase();
    switch (tag) {
      case "br":
        // Source line breaks are display-width artifacts; stripped per requirements.
        return;
      case "rp":
        return;
      case "ruby": {
        const rt = e.querySelector("rt");
        const base = Array.from(e.childNodes)
          .filter((c) => {
            if (c.nodeType !== 1) return true;
            const t = (c as Element).tagName.toLowerCase();
            return t !== "rt" && t !== "rp";
          })
          .map((c) => c.textContent ?? "")
          .join("");
        const reading = rt?.textContent ?? "";
        out.push(reading ? `${base}(${reading})` : base);
        return;
      }
      case "code": {
        // `parse.py` escapes only this one construct, so textContent is `<param=x>`.
        const param = e.getAttribute("data-param") ?? PARAM_TEXT.exec(e.textContent ?? "")?.[1];
        out.push(param ? `{${param}}` : (e.textContent ?? ""));
        return;
      }
      case "em":
        out.push("*");
        e.childNodes.forEach(walk);
        out.push("*");
        return;
      case "span": {
        const px = SIZE_STYLE.exec(e.getAttribute("style") ?? "")?.[1];
        if (px) {
          sizes.push(Number(px));
          out.push("^");
          e.childNodes.forEach(walk);
          out.push("^");
          return;
        }
        e.childNodes.forEach(walk);
        return;
      }
      default:
        e.childNodes.forEach(walk);
    }
  };

  el.childNodes.forEach(walk);
  return { text: out.join("").trim(), sizes };
}

const ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ESCAPE[c]);
}

/**
 * Kana reading in parentheses directly after a run of CJK — conservative enough
 * that ordinary parenthesised text is left alone.
 */
const RUBY_COMPACT = /([々一-鿿豈-﫿]+)\(([ぁ-ゟァ-ヿー]+)\)/g;
const PARAM_COMPACT = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;
const EM_COMPACT = /\*([^*]+)\*/g;
const BIG_COMPACT = /\^([^^]+)\^/g;

/**
 * Render compact text back to display HTML. Used for both the Japanese source and
 * the translation in the combined bilingual file.
 *
 * Ruby restoration only applies to the Japanese side: a translation has no kanji
 * base to attach a reading to, and `ruby: false` keeps `Name(reading)` as plain text.
 */
export function renderCompact(s: string, opts: { ruby?: boolean; sizes?: number[] } = {}): string {
  let html = escapeHtml(s);
  if (opts.ruby !== false) {
    html = html.replace(
      RUBY_COMPACT,
      (_m, base: string, reading: string) =>
        `<ruby>${base}<rp>(</rp><rt>${reading}</rt><rp>)</rp></ruby>`,
    );
  }
  html = html.replace(PARAM_COMPACT, (_m, name: string) => `<code>&lt;param=${name}&gt;</code>`);
  html = html.replace(EM_COMPACT, (_m, inner: string) => `<em>${inner}</em>`);
  let i = 0;
  html = html.replace(BIG_COMPACT, (_m, inner: string) => {
    const px = opts.sizes?.[i++];
    const style = px ? ` style="font-size: calc(${px}px * 0.5)"` : ` class="big"`;
    return `<span${style}>${inner}</span>`;
  });
  return html;
}
