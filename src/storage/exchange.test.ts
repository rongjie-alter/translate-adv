import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseBookHtml } from "../scenario/parseHtml";
import { isTranslatable } from "../scenario/model";
import {
  ArtifactError,
  artifactFileName,
  buildArtifact,
  mergeArtifacts,
  parseArtifact,
  serializeArtifact,
  type Artifact,
} from "./exchange";

const book = parseBookHtml(
  "touroumatsuri2026.book.html",
  readFileSync("book/touroumatsuri2026.book.html", "utf8"),
);
const chapter = book.chapters[0];

function make(overrides: Partial<Artifact> = {}, fill = true): Artifact {
  const translations = new Map<string, string>();
  if (fill) {
    for (const n of chapter.nodes) if (isTranslatable(n)) translations.set(n.uid, `[EN] ${n.src}`);
  }
  return {
    ...buildArtifact({
      book: book.file,
      srcHash: book.srcHash,
      chapter,
      lang: "en",
      model: "mock",
      translations,
      generatedAt: 1000,
    }),
    ...overrides,
  };
}

describe("buildArtifact", () => {
  const a = make();

  it("carries every translatable unit with its source", () => {
    expect(a.units).toHaveLength(chapter.units);
    expect(a.units.every((u) => u.src && u.tl)).toBe(true);
    expect(a.units[0].hash).toBeTruthy();
  });

  it("carries branch structure so combining needs no source file", () => {
    expect(a.markers.some((m) => m.kind === "label" && m.id)).toBe(true);
    expect(a.markers.some((m) => m.kind === "jump" && m.to)).toBe(true);
    expect(a.units.some((u) => u.kind === "select" && u.to)).toBe(true);
    // Markers point at the unit they precede, so order can be reconstructed.
    expect(a.markers.every((m) => m.at >= 0 && m.at <= a.units.length)).toBe(true);
  });

  it("keeps speaker names for the combined output", () => {
    expect(a.units.some((u) => u.speaker?.jp)).toBe(true);
  });

  it("records untranslated lines instead of hiding them", () => {
    const partial = make({}, false);
    expect(partial.incomplete).toHaveLength(chapter.units);
  });

  it("survives a JSON round trip", () => {
    const back = parseArtifact(serializeArtifact(a));
    expect(back).toEqual(a);
  });

  it("names files by book, chapter and language", () => {
    expect(artifactFileName(a)).toBe("touroumatsuri2026.tourou2026_0.en.tl.json");
  });
});

describe("parseArtifact", () => {
  it("rejects files that are not artifacts", () => {
    expect(() => parseArtifact("not json", "x.json")).toThrow(ArtifactError);
    expect(() => parseArtifact('{"hello":1}', "x.json")).toThrow(/not a translation file/);
    expect(() => parseArtifact('{"units":[]}', "x.json")).toThrow(/missing book/);
  });

  it("refuses artifacts from a newer app version", () => {
    const future = serializeArtifact({ ...make(), v: 99 });
    expect(() => parseArtifact(future, "x.json")).toThrow(/newer version/);
  });
});

describe("mergeArtifacts", () => {
  it("keeps one artifact per book, chapter and language", () => {
    const older = make({ generatedAt: 1000 });
    const newer = make({ generatedAt: 2000, model: "newer" });
    const { artifacts, conflicts } = mergeArtifacts([older, newer]);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].model).toBe("newer");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].differentSource).toBe(false);
  });

  it("prefers the more complete translation over the more recent one", () => {
    const complete = make({ generatedAt: 1000 });
    const partial = make({ generatedAt: 9999 }, false);
    const { artifacts } = mergeArtifacts([partial, complete]);
    expect(artifacts[0].generatedAt).toBe(1000);
  });

  it("flags translations made from a different version of the book", () => {
    const { conflicts } = mergeArtifacts([make(), make({ srcHash: "deadbeef", generatedAt: 2000 })]);
    expect(conflicts[0].differentSource).toBe(true);
  });

  it("keeps different chapters and languages side by side", () => {
    const en = make();
    const zh = make({ lang: "zh-hant" });
    const other = make({ chapter: "tourou2026_1-1" });
    const { artifacts, conflicts } = mergeArtifacts([en, zh, other]);
    expect(artifacts).toHaveLength(3);
    expect(conflicts).toHaveLength(0);
  });
});
