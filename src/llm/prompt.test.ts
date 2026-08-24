import { describe, expect, it } from "vitest";
import { buildSystemPrompt, DEFAULT_SYSTEM_PROMPT, glossaryBlock } from "./prompt";
import type { Speaker } from "../scenario/model";

describe("glossaryBlock", () => {
  it("omits character names that only contain question marks '？' or '?'", () => {
    const speakers: Speaker[] = [
      { jp: "？" },
      { jp: "？" },
      { jp: "？？？" },
      { jp: "?" },
      { jp: "???" },
      { jp: "？?", nameText: "？?" },
    ];
    expect(glossaryBlock(speakers, "en")).toBe("");
  });

  it("includes normal character names and filters out question-mark-only ones", () => {
    const speakers: Speaker[] = [
      { jp: "？" },
      { jp: "タサブロウ" },
      { jp: "？？？" },
      { jp: "男？" },
    ];
    const block = glossaryBlock(speakers, "en");
    expect(block).not.toContain("  ？");
    expect(block).not.toContain("  ？？？");
    expect(block).toContain("  タサブロウ");
    expect(block).toContain("  男？");
  });

  it("handles official translated names while filtering out question mark names", () => {
    const speakers: Speaker[] = [
      { jp: "？", tl: { en: "Unknown", "zh-hans": "未知", "zh-hant": "未知" } },
      { jp: "花子", tl: { en: "Hanako", "zh-hans": "花子", "zh-hant": "花子" } },
    ];
    const block = glossaryBlock(speakers, "en");
    expect(block).not.toContain("  ？ = Unknown");
    expect(block).toContain("  花子 = Hanako");
  });

  it("builds full system prompt without question-mark character names", () => {
    const speakers: Speaker[] = [
      { jp: "？" },
      { jp: "Alice", tl: { en: "Alice", "zh-hans": "爱丽丝", "zh-hant": "愛麗絲" } },
    ];
    const prompt = buildSystemPrompt(DEFAULT_SYSTEM_PROMPT, "en", speakers);
    expect(prompt).not.toContain("  ？");
    expect(prompt).toContain("  Alice = Alice");
  });

  it("promotes custom mappings into official entries for names without parser translations", () => {
    const speakers: Speaker[] = [
      { jp: "タサブロウ" },
      { jp: "ハナコ" },
    ];
    const block = glossaryBlock(speakers, "en", { "タサブロウ": "Tasaburou" });
    expect(block).toContain("Use these official character names exactly:");
    expect(block).toContain("  タサブロウ = Tasaburou");
    expect(block).toContain("Characters in this scene");
    expect(block).toContain("  ハナコ");
    expect(block).not.toContain("  タサブロウ\n");
  });

  it("lets parser metadata win over a custom mapping", () => {
    const speakers: Speaker[] = [
      { jp: "花子", tl: { en: "Hanako" } },
      { jp: "花子", tl: { en: "Hanako" } },
    ];
    const block = glossaryBlock(speakers, "en", { "花子": "MyOverride" });
    expect(block).toContain("  花子 = Hanako");
    expect(block).not.toContain("MyOverride");
  });

  it("keeps blank or whitespace-only custom mappings in the current fallback section", () => {
    const speakers: Speaker[] = [{ jp: "タサブロウ" }, { jp: "ハナコ" }];
    const block = glossaryBlock(speakers, "en", {
      "タサブロウ": "  ",
      "ハナコ": "",
    });
    expect(block).not.toContain("Use these official character names exactly:");
    expect(block).toContain("Characters in this scene");
    expect(block).toContain("  タサブロウ");
    expect(block).toContain("  ハナコ");
  });

  it("uses the same custom mapping through buildSystemPrompt", () => {
    const prompt = buildSystemPrompt(DEFAULT_SYSTEM_PROMPT, "en", [{ jp: "タサブロウ" }], {
      "タサブロウ": "Tasaburou",
    });
    expect(prompt).toContain("  タサブロウ = Tasaburou");
    expect(prompt).toContain("Use these official character names exactly:");
  });
});
