import { describe, expect, it } from "vitest";
import type { Artifact, ArtifactUnit } from "./exchange";
import {
  allChoices,
  defaultChoices,
  describeImport,
  hasDecisions,
  planImport,
  resolveImport,
} from "./importPlan";

const hanako = { jp: "花子", tl: { en: "Hanako" } };

function unit(id: string, tl: string, extra: Partial<ArtifactUnit> = {}): ArtifactUnit {
  return { id, kind: "text", src: `src ${id}`, tl, hash: id, ...extra };
}

function art(units: ArtifactUnit[], extra: Partial<Artifact> = {}): Artifact {
  return {
    v: 1,
    book: "book.book.html",
    srcHash: "aaaa",
    chapter: "ch1",
    lang: "en",
    model: "m-mine",
    generatedAt: 1000,
    units,
    markers: [],
    ...extra,
  };
}

const KEY = "book.book.html::ch1::en";

describe("planImport", () => {
  it("imports a chapter the browser does not have as new, with nothing to decide", () => {
    const plan = planImport([], [art([unit("a/1", "Hi")])]);
    expect(plan).toHaveLength(1);
    expect(plan[0].kind).toBe("new");
    expect(hasDecisions(plan)).toBe(false);
  });

  it("reports an identical chapter as identical", () => {
    const a = art([unit("a/1", "Hi")]);
    const plan = planImport([a], [{ ...a, generatedAt: 5000 }]);
    expect(plan[0].kind).toBe("identical");
    expect(hasDecisions(plan)).toBe(false);
  });

  it("fills lines the browser has empty without asking", () => {
    const mine = art([unit("a/1", "Hi"), unit("a/2", "")]);
    const inc = art([unit("a/1", "Hi"), unit("a/2", "Bye")], { generatedAt: 500 });
    const plan = planImport([mine], [inc]);
    expect(plan[0].kind).toBe("merge");
    expect(plan[0].fills).toEqual([{ uid: "a/2", text: "Bye" }]);
    expect(plan[0].conflicts).toEqual([]);
    expect(hasDecisions(plan)).toBe(false);
  });

  it("keeps a line the file has empty without asking", () => {
    const mine = art([unit("a/1", "Hi")]);
    const plan = planImport([mine], [art([unit("a/1", "")])]);
    expect(plan[0].kind).toBe("identical");
  });

  it("treats a line that differs only by an echoed speaker name as identical", () => {
    const mine = art([unit("a/1", "Hello there.", { speaker: hanako })]);
    const inc = art([unit("a/1", "Hanako: Hello there.", { speaker: hanako })]);
    expect(planImport([mine], [inc])[0].kind).toBe("identical");
  });

  it("suggests the newer side by line time, falling back to the job's time", () => {
    const mine = art([unit("a/1", "edited"), unit("a/2", "from run")], { generatedAt: 9000 });
    const inc = art([unit("a/1", "theirs 1"), unit("a/2", "theirs 2")], { generatedAt: 3000 });
    const plan = planImport([mine], [inc], {
      lines: new Map([[KEY, new Map([["a/1", 4000]])]]),
      chapters: new Map([[KEY, 2000]]),
    });
    const [l1, l2] = plan[0].conflicts;
    expect(l1).toMatchObject({ uid: "a/1", mineAt: 4000, incomingAt: 3000, suggested: "mine" });
    expect(l2).toMatchObject({ uid: "a/2", mineAt: 2000, suggested: "incoming" });
    expect(hasDecisions(plan)).toBe(true);
  });

  it("keeps mine on a tie", () => {
    const mine = art([unit("a/1", "mine")], { generatedAt: 1000 });
    const inc = art([unit("a/1", "theirs")], { generatedAt: 1000 });
    expect(planImport([mine], [inc])[0].conflicts[0].suggested).toBe("mine");
  });

  it("makes a different book version a whole-chapter choice, defaulting to mine", () => {
    const mine = art([unit("a/1", "mine")]);
    const inc = art([unit("a/1", "theirs")], { srcHash: "bbbb", generatedAt: 9999 });
    const plan = planImport([mine], [inc]);
    expect(plan[0]).toMatchObject({ kind: "version-mismatch", suggested: "mine" });
    expect(hasDecisions(plan)).toBe(true);
  });

  it("suggests the file for a different version when mine has nothing translated", () => {
    const mine = art([unit("a/1", "")]);
    const inc = art([unit("a/1", "theirs")], { srcHash: "bbbb" });
    expect(planImport([mine], [inc])[0].suggested).toBe("incoming");
  });

  it("keeps the more complete of two incoming copies of one chapter", () => {
    const partial = art([unit("a/1", "x"), unit("a/2", "")], { generatedAt: 5000 });
    const full = art([unit("a/1", "x"), unit("a/2", "y")], { generatedAt: 100 });
    const plan = planImport([], [partial, full]);
    expect(plan).toHaveLength(1);
    expect(plan[0].incoming).toBe(full);
  });
});

describe("resolveImport", () => {
  const mine = art([unit("a/1", "mine 1"), unit("a/2", ""), unit("a/3", "mine 3")]);
  const inc = art(
    [unit("a/1", "theirs 1"), unit("a/2", "theirs 2"), unit("a/3", "theirs 3", { model: "m-line" })],
    { model: "m-theirs", generatedAt: 5000 },
  );

  it("applies fills and the chosen lines, and records unit rows per model", () => {
    const plan = planImport([mine], [inc]);
    const choices = defaultChoices(plan); // both conflicts are newer in the file
    choices.lines[KEY]["a/1"] = "mine";
    const r = resolveImport(plan, choices, 7000);

    expect(r.artifacts).toHaveLength(1);
    const out = r.artifacts[0].artifact;
    expect(out.units.map((u) => u.tl)).toEqual(["mine 1", "theirs 2", "theirs 3"]);
    expect(out.units[1].model).toBe("m-theirs");
    expect(out.units[2].model).toBe("m-line");
    // The newer of the two sides, not the time of the import.
    expect(out.generatedAt).toBe(5000);
    expect(out.incomplete).toBeUndefined();

    const writes = Object.fromEntries(r.unitWrites.map((w) => [w.model, [...w.texts.keys()]]));
    expect(writes).toEqual({ "m-theirs": ["a/2"], "m-line": ["a/3"] });
    expect(r.unitWrites.every((w) => w.at === 5000 && w.key === KEY)).toBe(true);
    // A fill had nothing before it; a replaced line remembers what it replaced.
    const prev = Object.fromEntries(r.unitWrites.flatMap((w) => [...w.previous]));
    expect(prev).toEqual({ "a/3": "mine 3" });
    expect(r.summary).toMatchObject({ filledLines: 1, takenLines: 1, keptLines: 1 });
  });

  it("changes nothing when every conflict keeps mine and there are no fills", () => {
    const m = art([unit("a/1", "mine")]);
    const plan = planImport([m], [art([unit("a/1", "theirs")], { generatedAt: 5000 })]);
    const r = resolveImport(plan, allChoices(plan, "mine"), 7000);
    expect(r.artifacts).toEqual([]);
    expect(r.unitWrites).toEqual([]);
    expect(describeImport(r.summary)).toBe("Imported: 1 line kept.");
  });

  it("replaces a different-version chapter whole only when asked", () => {
    const other = art([unit("b/1", "theirs")], { srcHash: "bbbb" });
    const plan = planImport([mine], [other]);
    expect(resolveImport(plan, defaultChoices(plan), 1).artifacts).toEqual([]);
    const r = resolveImport(plan, allChoices(plan, "incoming"), 1);
    expect(r.artifacts[0]).toEqual({ artifact: other, kind: "version-mismatch" });
    expect(r.unitWrites).toEqual([]);
  });

  it("describes an import with nothing new as up to date", () => {
    const plan = planImport([mine], [mine]);
    expect(describeImport(resolveImport(plan, defaultChoices(plan), 1).summary)).toBe(
      "Already up to date: 1 chapter identical.",
    );
  });
});

describe("source versions", () => {
  it("does not match lines by id when either side has no srcHash", () => {
    const mine = art([unit("a/1", "mine"), unit("a/2", "")]);
    const hashless = art([unit("a/1", "theirs"), unit("a/2", "other line")], { srcHash: "" });
    for (const [own, inc] of [
      [mine, hashless],
      [{ ...mine, srcHash: "" }, art([unit("a/1", "theirs")])],
    ]) {
      const plan = planImport([own], [inc]);
      expect(plan[0].kind).toBe("version-mismatch");
      expect(plan[0].fills).toEqual([]);
      expect(hasDecisions(plan)).toBe(true);
    }
  });
});

describe("times after a merge", () => {
  it("keeps untouched lines at their real age, so a later file is still suggested", () => {
    const a = art([unit("a/1", "from A"), unit("a/2", "")], { generatedAt: 1000 });
    const b = art([unit("a/1", "from A"), unit("a/2", "from B")], { generatedAt: 3000 });
    const merged = resolveImport(planImport([a], [b]), defaultChoices(planImport([a], [b])), 99_000)
      .artifacts[0].artifact;
    const c = art([unit("a/1", "from C"), unit("a/2", "from B")], { generatedAt: 2000 });
    const plan = planImport([merged], [c]);
    expect(plan[0].conflicts[0]).toMatchObject({ uid: "a/1", mineAt: 3000, suggested: "mine" });
    const d = art([unit("a/1", "from D"), unit("a/2", "from B")], { generatedAt: 4000 });
    expect(planImport([merged], [d])[0].conflicts[0].suggested).toBe("incoming");
  });
});
