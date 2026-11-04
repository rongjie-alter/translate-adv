/**
 * The little markdown the summarizer needs, in both directions.
 *
 * Synopses are paragraphs with the odd `**bold**` or `*italic*`, so this renders only
 * that rather than pulling in a parser. Text is escaped first, which is what makes
 * feeding the result to `dangerouslySetInnerHTML` safe.
 */
import { escapeHtml } from "../scenario/inline";

export function renderMarkdown(md: string): string {
  const text = md.trim();
  if (!text) return "";
  return text
    .split(/\n{2,}/)
    .map((block) => {
      const html = escapeHtml(block)
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
        .replace(/\n/g, "<br>");
      return `<p>${html}</p>`;
    })
    .join("");
}

/** A whole book's synopses as one `.md` file: a title, then a heading per chapter. */
export function exportMarkdown(title: string, chapters: { title: string; markdown: string }[]): string {
  const parts = [`# ${title}`];
  for (const c of chapters) parts.push(`## ${c.title}\n\n${c.markdown.trim()}`);
  return `${parts.join("\n\n")}\n`;
}

/** File name for the export, without anything a filesystem objects to. */
export function exportFileName(title: string): string {
  const base = title.replace(/\.book\.html$|\.bilingual\.html$|\.html$/i, "");
  return `${base.replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^_+|_+$/g, "") || "summary"}.summary.md`;
}
