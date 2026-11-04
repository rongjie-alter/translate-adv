import { describe, expect, it } from "vitest";
import { exportFileName, exportMarkdown, renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("makes paragraphs, bold and italic", () => {
    expect(renderMarkdown("**Ann** went.\n\nThen *left*.")).toBe(
      "<p><strong>Ann</strong> went.</p><p>Then <em>left</em>.</p>",
    );
  });

  it("escapes HTML before anything else", () => {
    expect(renderMarkdown('<img src=x onerror="alert(1)"> & more')).toBe(
      '<p>&lt;img src=x onerror="alert(1)"&gt; &amp; more</p>',
    );
  });

  it("renders nothing for empty text", () => {
    expect(renderMarkdown("  \n ")).toBe("");
  });
});

describe("exportMarkdown", () => {
  it("writes a heading per chapter", () => {
    expect(exportMarkdown("Book", [{ title: "1-1", markdown: "A.\n" }, { title: "1-2", markdown: "B." }])).toBe(
      "# Book\n\n## 1-1\n\nA.\n\n## 1-2\n\nB.\n",
    );
  });

  it("makes a safe file name", () => {
    expect(exportFileName("touroumatsuri2026.book.html")).toBe("touroumatsuri2026.summary.md");
    expect(exportFileName("a: b/c — d.en.bilingual.html")).toBe("a_b_c_—_d.en.summary.md");
    expect(exportFileName("***")).toBe("summary.summary.md");
  });
});
