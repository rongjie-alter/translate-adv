import { describe, expect, it } from "vitest";
import { parseFolderFileName, scanBookGroups } from "./groups";
import type { Artifact } from "./exchange";
import type { SourceRecord } from "./db";

const mockArtifactEn: Artifact = {
  v: 1,
  book: "touroumatsuri2026.book.html",
  srcHash: "abc",
  chapter: "1-1",
  lang: "en",
  model: "mock",
  generatedAt: 1000,
  units: [{ id: "L0/1", kind: "text", src: "こんにちは", tl: "Hello", hash: "h1" }],
  markers: [],
};

const mockSource: SourceRecord = {
  id: "touroumatsuri2026.book.html:hash1",
  file: "touroumatsuri2026.book.html",
  srcHash: "abc",
  html: "<html></html>",
  addedAt: 1000,
};

describe("groups", () => {
  describe("parseFolderFileName", () => {
    it("parses .tl.json files", () => {
      const p = parseFolderFileName("touroumatsuri2026.1-1.en.tl.json");
      expect(p.type).toBe("artifact");
      expect(p.bookBase).toBe("touroumatsuri2026");
      expect(p.chapter).toBe("1-1");
      expect(p.lang).toBe("en");
    });

    it("parses .bundle.json files", () => {
      const p = parseFolderFileName("touroumatsuri2026.en.bundle.json");
      expect(p.type).toBe("bundle");
      expect(p.bookBase).toBe("touroumatsuri2026");
      expect(p.lang).toBe("en");
    });

    it("parses .bilingual.html files", () => {
      const p = parseFolderFileName("touroumatsuri2026.en.bilingual.html");
      expect(p.type).toBe("bilingual");
      expect(p.bookBase).toBe("touroumatsuri2026");
      expect(p.lang).toBe("en");
    });

    it("parses source .book.html files", () => {
      const p = parseFolderFileName("touroumatsuri2026.book.html");
      expect(p.type).toBe("source");
      expect(p.bookBase).toBe("touroumatsuri2026");
    });
  });

  describe("scanBookGroups", () => {
    it("detects group in DB only", () => {
      const groups = scanBookGroups([], [mockArtifactEn], [mockSource]);
      expect(groups).toHaveLength(1);
      expect(groups[0].book).toBe("touroumatsuri2026.book.html");
      expect(groups[0].lang).toBe("en");
      expect(groups[0].inDb).toBe(true);
      expect(groups[0].artifacts).toHaveLength(1);
    });

    it("detects group in folder only without reading content", () => {
      const folderFiles = [
        "touroumatsuri2026.1-1.en.tl.json",
        "touroumatsuri2026.1-2.en.tl.json",
        "touroumatsuri2026.book.html",
      ];
      const groups = scanBookGroups(folderFiles, [], []);
      expect(groups).toHaveLength(1);
      expect(groups[0].book).toBe("touroumatsuri2026.book.html");
      expect(groups[0].lang).toBe("en");
      expect(groups[0].inDb).toBe(false);
      expect(groups[0].artifacts).toHaveLength(0);
      expect(groups[0].artifactFiles).toEqual([
        "touroumatsuri2026.1-1.en.tl.json",
        "touroumatsuri2026.1-2.en.tl.json",
      ]);
      expect(groups[0].sourceFile).toBe("touroumatsuri2026.book.html");
    });

    it("detects when group is both in DB and folder", () => {
      const folderFiles = [
        "touroumatsuri2026.1-1.en.tl.json",
        "touroumatsuri2026.1-2.en.tl.json",
        "touroumatsuri2026.book.html",
      ];
      const groups = scanBookGroups(folderFiles, [mockArtifactEn], [mockSource]);
      expect(groups).toHaveLength(1);
      expect(groups[0].inDb).toBe(true);
      expect(groups[0].artifacts).toHaveLength(1);
      expect(groups[0].folderFiles).toHaveLength(3);
    });

    it("splits multiple languages into distinct groups", () => {
      const folderFiles = [
        "touroumatsuri2026.1-1.en.tl.json",
        "touroumatsuri2026.1-1.zh-hans.tl.json",
        "touroumatsuri2026.book.html",
      ];
      const groups = scanBookGroups(folderFiles, [], []);
      expect(groups).toHaveLength(2);
      expect(groups.map((g) => g.lang)).toEqual(["en", "zh-hans"]);
      expect(groups[0].inDb).toBe(false);
      expect(groups[1].inDb).toBe(false);
    });
  });
});
