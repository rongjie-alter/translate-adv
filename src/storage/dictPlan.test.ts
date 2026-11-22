import { describe, expect, it } from "vitest";
import {
  allDictChoices,
  defaultDictChoices,
  describeDict,
  hasDictDecisions,
  parseDictionaryFile,
  planDictBackup,
  planDictImport,
  resolveDict,
  summarizeDict,
} from "./dictPlan";

const mine = { en: { 花子: "Hanako", 太郎: "Taro", 次郎: "Jiro" } };
const file = { en: { 花子: "Hanako", 太郎: "Tarou", 三郎: "Saburo" } };

describe("planDictImport", () => {
  it("adds new entries without asking and keeps the browser's value on a clash", () => {
    const plan = planDictImport(mine, file);
    expect(plan.diffs.map((d) => [d.key, d.kind])).toEqual([
      ["太郎", "clash"],
      ["三郎", "added"],
    ]);
    expect(hasDictDecisions(plan)).toBe(true);
    const out = resolveDict(mine, plan, defaultDictChoices(plan));
    expect(out.en).toEqual({ 花子: "Hanako", 太郎: "Taro", 次郎: "Jiro", 三郎: "Saburo" });
  });

  it("takes the file's values when asked, and never deletes browser-only entries", () => {
    const plan = planDictImport(mine, file);
    const out = resolveDict(mine, plan, allDictChoices(plan, "theirs"));
    expect(out.en).toEqual({ 花子: "Hanako", 太郎: "Tarou", 次郎: "Jiro", 三郎: "Saburo" });
  });

  it("has nothing to decide when the file only adds entries", () => {
    expect(hasDictDecisions(planDictImport(mine, { en: { 四郎: "Shiro" } }))).toBe(false);
  });
});

describe("planDictBackup", () => {
  it("drops file-only entries by default and writes browser-only ones", () => {
    const plan = planDictBackup(mine, file);
    expect(plan.diffs.map((d) => [d.key, d.kind])).toEqual([
      ["太郎", "clash"],
      ["次郎", "browser-only"],
      ["三郎", "file-only"],
    ]);
    const out = resolveDict(mine, plan, defaultDictChoices(plan));
    expect(out.en).toEqual(mine.en);
  });

  it("adds a kept file-only entry to the browser too", () => {
    const plan = planDictBackup(mine, file);
    const choices = defaultDictChoices(plan);
    choices[plan.diffs.find((d) => d.key === "三郎")!.id] = "theirs";
    const out = resolveDict(mine, plan, choices);
    expect(out.en?.["三郎"]).toBe("Saburo");
    expect(summarizeDict(mine, out)).toEqual({ added: 1, changed: 0, removed: 0 });
  });

  it("has nothing to decide when the file is a subset of the browser", () => {
    const plan = planDictBackup(mine, { en: { 花子: "Hanako" } });
    expect(hasDictDecisions(plan)).toBe(false);
    expect(plan.diffs).toHaveLength(2);
  });

  it("keeps the file's entries by default for a language the browser has nothing for", () => {
    const backup = { en: { 花子: "Hanako" }, "zh-hans": { 花子: "花子" } };
    const fresh = planDictBackup({}, backup);
    expect(resolveDict({}, fresh, defaultDictChoices(fresh))).toMatchObject(backup);
    // Only the empty language is protected; en still drops what the browser lacks.
    const partial = planDictBackup({ en: { 太郎: "Taro" } }, backup);
    const out = resolveDict({ en: { 太郎: "Taro" } }, partial, defaultDictChoices(partial));
    expect(out.en).toEqual({ 太郎: "Taro" });
    expect(out["zh-hans"]).toEqual({ 花子: "花子" });
    // Still a decision the user can override.
    expect(hasDictDecisions(fresh)).toBe(true);
    expect(resolveDict({}, fresh, allDictChoices(fresh, "mine")).en).toEqual({});
  });

  it("reports identical dictionaries as having no differences", () => {
    expect(planDictBackup(mine, { ...mine, "zh-hans": {} }).diffs).toEqual([]);
  });
});

describe("parseDictionaryFile", () => {
  it("reads the per-language shape, trimming and dropping junk", () => {
    const d = parseDictionaryFile('{"en":{" 花子 ":" Hanako ","x":"","y":3},"zh-hans":{"花子":"花子"}}');
    expect(d.en).toEqual({ 花子: "Hanako" });
    expect(d["zh-hans"]).toEqual({ 花子: "花子" });
    expect(d["zh-hant"]).toEqual({});
  });

  it("reads a flat map into the given language only", () => {
    expect(parseDictionaryFile('{"花子":"Hanako"}', "en").en).toEqual({ 花子: "Hanako" });
  });

  it("refuses a flat map when no language is given, and non-objects", () => {
    expect(() => parseDictionaryFile('{"花子":"Hanako"}')).toThrow(/not a dictionary backup/);
    expect(() => parseDictionaryFile("[1]", "en")).toThrow(/not a dictionary/);
    expect(() => parseDictionaryFile("nope", "en")).toThrow(/not valid JSON/);
  });
});

describe("describeDict", () => {
  it("names each kind of change", () => {
    expect(describeDict({ added: 2, changed: 1, removed: 0 })).toBe("2 added, 1 changed");
    expect(describeDict({ added: 0, changed: 0, removed: 0 })).toBe("no changes");
  });
});
