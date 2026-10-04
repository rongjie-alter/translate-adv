import { describe, expect, it } from "vitest";
import { assembleSystemPrompt, buildSystemPrompt, DEFAULT_SYSTEM_PROMPT, glossaryBlock } from "./prompt";
import { speakerGlossary } from "../scenario/glossary";
import type { GlossaryEntry, Speaker } from "../scenario/model";

const entry = (jp: string, tl: string, source: GlossaryEntry["source"] = "official"): GlossaryEntry => ({
  jp,
  tl,
  source,
  count: 1,
});

describe("glossaryBlock", () => {
  it("is empty without entries, so the template has no stray heading", () => {
    expect(glossaryBlock([])).toBe("");
  });

  it("renders names and terms under one heading", () => {
    const block = glossaryBlock([entry("花子", "Hanako", "speaker"), entry("パラレルフライト", "Parallel Flight", "custom")]);
    expect(block).toContain("Use these official names and terms exactly:");
    expect(block).toContain("  花子 = Hanako");
    expect(block).toContain("  パラレルフライト = Parallel Flight");
  });
});

describe("speakerGlossary", () => {
  it("omits character names that only contain question marks '？' or '?'", () => {
    const speakers: Speaker[] = [
      { jp: "？", tl: { en: "Unknown" } },
      { jp: "？？？", tl: { en: "Unknown" } },
      { jp: "?" },
      { jp: "？?", nameText: "？?" },
    ];
    expect(speakerGlossary(speakers, "en")).toEqual([]);
  });

  it("keeps official names and drops speakers with neither an official nor a custom name", () => {
    const speakers: Speaker[] = [{ jp: "タサブロウ" }, { jp: "花子", tl: { en: "Hanako" } }];
    const g = speakerGlossary(speakers, "en");
    expect(g.map((e) => `${e.jp}=${e.tl}`)).toEqual(["花子=Hanako"]);
  });

  it("promotes custom mappings for names without parser translations, parser wins otherwise", () => {
    const speakers: Speaker[] = [
      { jp: "タサブロウ" },
      { jp: "ハナコ" },
      { jp: "花子", tl: { en: "Hanako" } },
    ];
    const g = speakerGlossary(speakers, "en", { タサブロウ: "Tasaburou", 花子: "MyOverride", ハナコ: "  " });
    expect(g.map((e) => `${e.jp}=${e.tl}`)).toEqual(["タサブロウ=Tasaburou", "花子=Hanako"]);
  });
});

describe("buildSystemPrompt / assembleSystemPrompt", () => {
  it("builds full system prompt with Simplified Chinese for zh-hans", () => {
    const prompt = buildSystemPrompt(DEFAULT_SYSTEM_PROMPT, "zh-hans", []);
    expect(prompt).toContain("into Simplified Chinese.");
    expect(prompt).not.toContain("简体中文");
    expect(prompt).not.toContain("{{glossary}}");
  });

  it("puts the glossary before the output rules", () => {
    const prompt = buildSystemPrompt(DEFAULT_SYSTEM_PROMPT, "en", [entry("Alice", "Alice")]);
    expect(prompt.indexOf("  Alice = Alice")).toBeGreaterThan(-1);
    expect(prompt.indexOf("  Alice = Alice")).toBeLessThan(prompt.indexOf("Output rules:"));
  });

  it("appends the per-file note after the glossary", () => {
    const prompt = assembleSystemPrompt({
      template: DEFAULT_SYSTEM_PROMPT,
      lang: "en",
      glossary: [entry("花子", "Hanako")],
      fileNote: "花子 is a teenager.",
    });
    expect(prompt).toContain("  花子 = Hanako");
    expect(prompt.endsWith("花子 is a teenager.")).toBe(true);
  });
});
