import { describe, expect, it } from "vitest";
import { isTranslatable, type Book, type Chapter } from "../scenario/model";
import {
  ArtifactError,
  artifactFileName,
  buildArtifact,
  mergeArtifacts,
  parseArtifact,
  serializeArtifact,
  type Artifact,
} from "./exchange";

const chapter: Chapter = {
  name: "tourou2026_0",
  nodes: [
    { kind: "label", id: "quest_evMain_touroumatsuri2026_0_a_alt1" },
    { kind: "text", uid: "tourou2026_0_a_alt1/1", src: "こんにちは", hash: "11111111", speaker: { jp: "タサブロウ" } },
    { kind: "select", uid: "tourou2026_0_a_alt1/2", src: "（飛び起きる）", hash: "22222222", to: "quest_evMain_touroumatsuri2026_0_b_alt1" },
    { kind: "jump", to: "quest_evMain_touroumatsuri2026_0_b_alt1" },
    { kind: "text", uid: "tourou2026_0_a_alt1/3", src: "またね", hash: "33333333", speaker: { jp: "花子", tl: { en: "Hanako" } } },
  ],
  units: 3,
  chars: 30,
};
const book: Book = {
  file: "touroumatsuri2026.book.html",
  srcHash: "00000000",
  chapters: [chapter],
  hasMeta: true,
  hasCharaMeta: true,
};

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

  it("persists a custom target-language speaker name into the artifact", () => {
    const translations = new Map<string, string>();
    for (const n of chapter.nodes) if (isTranslatable(n)) translations.set(n.uid, `[EN] ${n.src}`);
    const first = chapter.nodes.find(
      (n): n is Extract<typeof n, { kind: "text" }> => n.kind === "text" && !!n.speaker,
    )!;
    const display = first.speaker!.nameText ?? first.speaker!.jp;
    const custom = buildArtifact({
      book: book.file,
      srcHash: book.srcHash,
      chapter,
      lang: "en",
      model: "mock",
      translations,
      generatedAt: 1000,
      customNames: { [display]: "Custom Hero" },
    });

    const matching = custom.units.find((u) => u.id === first.uid);
    expect(matching?.speaker?.tl?.en).toBe("Custom Hero");
    expect(matching?.speaker?.tl?.["zh-hans"] ?? matching?.speaker?.jp).toBe(matching?.speaker?.jp);
    expect(matching?.speaker?.jp).toBe(first.speaker!.jp);
  });

  it("does not overwrite a parser-provided official translation with a custom name", () => {
    const translations = new Map<string, string>();
    for (const n of chapter.nodes) if (isTranslatable(n)) translations.set(n.uid, `[EN] ${n.src}`);
    const firstOfficial = chapter.nodes.find(
      (n): n is Extract<typeof n, { kind: "text" }> =>
        n.kind === "text" && !!n.speaker?.tl?.en,
    )!;
    const display = firstOfficial.speaker!.nameText ?? firstOfficial.speaker!.jp;
    const original = firstOfficial.speaker!.tl!.en;
    const custom = buildArtifact({
      book: book.file,
      srcHash: book.srcHash,
      chapter,
      lang: "en",
      model: "mock",
      translations,
      generatedAt: 1000,
      customNames: { [display]: "Custom Override" },
    });

    const matching = custom.units.find((u) => u.id === firstOfficial.uid);
    expect(matching?.speaker?.tl?.en).toBe(original);
    expect(matching?.speaker?.tl?.en).not.toBe("Custom Override");
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
