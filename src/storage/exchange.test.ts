import { describe, expect, it } from "vitest";
import { isTranslatable, type Book, type Chapter } from "../scenario/model";
import {
  ArtifactError,
  applyTranslations,
  artifactFileName,
  buildArtifact,
  mergeArtifacts,
  parseArtifact,
  serializeArtifact,
  shiftTranslations,
  shiftTranslationsByOffset,
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

describe("applyTranslations", () => {
  it("can update text while preserving each line's existing model marker", () => {
    const marked = make({
      units: make().units.map((unit, index) =>
        index === 1 ? { ...unit, model: "other-model" } : unit,
      ),
    });
    const next = applyTranslations(marked, new Map([[marked.units[1].id, "shifted"]]), {
      model: marked.model,
      at: 2000,
      preserveModel: true,
    });

    expect(next.units[1].tl).toBe("shifted");
    expect(next.units[1].model).toBe("other-model");
  });
});

describe("shiftTranslations", () => {
  const units: Artifact["units"] = [1, 2, 3, 4, 5].map((n) => ({
    id: `line/${n}`,
    kind: "text",
    src: `src ${n}`,
    tl: `tl ${n}`,
    hash: `${n}`,
  }));

  it("shifts selected rows down and clears the vacated row", () => {
    const result = shiftTranslations(units, [1, 2, 3], "down");

    expect(result?.destinationIndexes).toEqual([2, 3, 4]);
    expect([...result!.translations]).toEqual([
      ["line/2", ""],
      ["line/3", "tl 2"],
      ["line/4", "tl 3"],
      ["line/5", "tl 4"],
    ]);
  });

  it("shifts selected rows up and clears the vacated row", () => {
    const result = shiftTranslations(units, [1, 2, 3], "up");

    expect(result?.destinationIndexes).toEqual([0, 1, 2]);
    expect([...result!.translations]).toEqual([
      ["line/1", "tl 2"],
      ["line/2", "tl 3"],
      ["line/3", "tl 4"],
      ["line/4", ""],
    ]);
  });

  it("preserves rows outside the touched range while replacing the destination row", () => {
    const result = shiftTranslations(units, [1, 2], "down");
    const next = units.map((unit) => ({
      ...unit,
      tl: result?.translations.get(unit.id) ?? unit.tl,
    }));

    expect(next.map((unit) => unit.tl)).toEqual(["tl 1", "", "tl 2", "tl 3", "tl 5"]);
  });

  it("rejects empty, non-contiguous, and boundary selections", () => {
    expect(shiftTranslations(units, [], "down")).toBeNull();
    expect(shiftTranslations(units, [1, 3], "down")).toBeNull();
    expect(shiftTranslations(units, [0, 1], "up")).toBeNull();
    expect(shiftTranslations(units, [3, 4], "down")).toBeNull();
  });

  it("supports empty translations so the caller can recompute incomplete rows", () => {
    const partial = units.map((unit, index) => ({ ...unit, tl: index === 1 ? "" : unit.tl }));
    const result = shiftTranslations(partial, [1, 2], "down");
    const next = partial.map((unit) => ({
      ...unit,
      tl: result?.translations.get(unit.id) ?? unit.tl,
    }));

    expect(next.filter((unit) => !unit.tl).map((unit) => unit.id)).toEqual(["line/2", "line/3"]);
  });

  it("computes a reversed preview from the original range instead of accumulating gaps", () => {
    const result = shiftTranslationsByOffset(units, [2, 3], 1);
    const next = units.map((unit) => ({
      ...unit,
      tl: result?.translations.get(unit.id) ?? unit.tl,
    }));

    expect(next.map((unit) => unit.tl)).toEqual(["tl 1", "tl 2", "", "tl 3", "tl 4"]);
    expect(result?.destinationIndexes).toEqual([3, 4]);
  });

  it("makes up two then down three equivalent to one net shift down", () => {
    let offset = 0;
    let result = shiftTranslationsByOffset(units, [2, 3], offset);
    for (const direction of ["up", "up", "down", "down", "down"] as const) {
      offset += direction === "up" ? -1 : 1;
      result = shiftTranslationsByOffset(units, [2, 3], offset);
    }

    const next = units.map((unit) => ({
      ...unit,
      tl: result?.translations.get(unit.id) ?? unit.tl,
    }));

    expect(next.map((unit) => unit.tl)).toEqual(["tl 1", "tl 2", "", "tl 3", "tl 4"]);
  });

  it("preserves rows between the source and destination ranges", () => {
    const result = shiftTranslationsByOffset(units, [0, 1], 3);
    const next = units.map((unit) => ({
      ...unit,
      tl: result?.translations.get(unit.id) ?? unit.tl,
    }));

    expect(next.map((unit) => unit.tl)).toEqual(["", "", "tl 3", "tl 1", "tl 2"]);
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
