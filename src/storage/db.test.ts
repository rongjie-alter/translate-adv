/**
 * Only the pure part of `db.ts`.
 *
 * The IndexedDB wrapper itself stays untested — there is no fake-indexeddb in the
 * project, and the transaction plumbing is the same shape everywhere. The
 * interesting logic is which fields a write folds into an existing row, so that is
 * what `mergeUnitRecord` exists to make testable.
 */
import { describe, expect, it } from "vitest";
import { mergeUnitRecord, type UnitRecord } from "./db";

const JOB = "b.html::ch1::en";
const row = (text: string, extra: Partial<UnitRecord> = {}): UnitRecord => ({
  key: `${JOB}::u/1`,
  jobId: JOB,
  uid: "u/1",
  text,
  ...extra,
});

describe("mergeUnitRecord", () => {
  it("writes a fresh row with no history", () => {
    const r = mergeUnitRecord(undefined, { jobId: JOB, uid: "u/1", text: "hello" });
    expect(r).toEqual({ key: `${JOB}::u/1`, jobId: JOB, uid: "u/1", text: "hello" });
  });

  it("keeps the replaced text when asked, so a bad retry can be undone", () => {
    const r = mergeUnitRecord(row("old"), { jobId: JOB, uid: "u/1", text: "new" }, {
      keepPrevious: true,
    });
    expect(r.text).toBe("new");
    expect(r.prev).toBe("old");
  });

  it("does not record a no-op as history", () => {
    const r = mergeUnitRecord(row("same"), { jobId: JOB, uid: "u/1", text: "same" }, {
      keepPrevious: true,
    });
    expect(r.prev).toBeUndefined();
  });

  it("leaves history alone on a normal write", () => {
    const r = mergeUnitRecord(row("old"), { jobId: JOB, uid: "u/1", text: "new" });
    expect(r.prev).toBeUndefined();
  });

  it("carries an existing history forward rather than losing it", () => {
    const r = mergeUnitRecord(row("b", { prev: "a" }), { jobId: JOB, uid: "u/1", text: "b" });
    expect(r.prev).toBe("a");
  });

  it("keeps only one level — a second retry replaces the history", () => {
    const first = mergeUnitRecord(row("a"), { jobId: JOB, uid: "u/1", text: "b" }, {
      keepPrevious: true,
    });
    const second = mergeUnitRecord(first, { jobId: JOB, uid: "u/1", text: "c" }, {
      keepPrevious: true,
    });
    expect(second.text).toBe("c");
    expect(second.prev).toBe("b");
  });

  it("stamps provenance when given it", () => {
    const r = mergeUnitRecord(undefined, { jobId: JOB, uid: "u/1", text: "x" }, {
      model: "other",
      at: 42,
    });
    expect(r.model).toBe("other");
    expect(r.at).toBe(42);
  });
});
