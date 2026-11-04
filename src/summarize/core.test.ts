import { describe, expect, it } from "vitest";
import { LlmError, type ChatResponse } from "../llm/client";
import type { Quota } from "../llm/limiter";
import type { SummaryChapter, SummaryDoc } from "./doc";
import {
  cleanSynopsis,
  planSummary,
  splitText,
  summarizeChapter,
  summarizeDoc,
  type SummarizeDeps,
  type SummarizeEvent,
} from "./core";

const openQuota: Quota = {
  check: () => ({ waitMs: 0 }),
  reserve: () => {},
  settle: () => {},
  penalize: () => {},
};

interface Sent {
  system: string;
  user: string;
}

/** A model that answers `synopsis of <title>` and remembers what it was sent. */
function fakeDeps(over: Partial<SummarizeDeps> = {}, reply?: (s: Sent) => string | Error) {
  const sent: Sent[] = [];
  const events: SummarizeEvent[] = [];
  const deps: SummarizeDeps = {
    limiter: openQuota,
    apiKey: "k",
    baseUrl: "http://x",
    model: "m",
    maxOutputTokens: 1000,
    charsPerToken: 1,
    maxInputTokens: 100_000,
    onEvent: (e) => events.push(e),
    sleep: async () => {},
    chat: async (req): Promise<ChatResponse> => {
      const s = { system: req.system, user: req.user };
      sent.push(s);
      const out = reply ? reply(s) : `synopsis of ${/<chapter title="([^"]*)"/.exec(req.user)?.[1]}`;
      if (out instanceof Error) throw out;
      return {
        content: out,
        finishReason: "stop",
        status: 200,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      };
    },
    ...over,
  };
  return { deps, sent, events };
}

const ch = (id: string, text = `${id} line`): SummaryChapter => ({ id, title: id, text });
const docOf = (...ids: string[]): SummaryDoc => ({
  id: "book:x",
  title: "x",
  origin: "book",
  chapters: ids.map((id) => ch(id)),
});
const signal = () => new AbortController().signal;

describe("splitText", () => {
  it("keeps text that fits in one piece", () => {
    expect(splitText("a\nb", 100, 1)).toEqual(["a\nb"]);
  });

  it("splits on line boundaries and loses nothing", () => {
    const text = Array.from({ length: 40 }, (_, i) => `行${i}`.padEnd(10, "あ")).join("\n");
    const pieces = splitText(text, 50, 1);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join("\n")).toBe(text);
  });

  it("cuts a single over-long line rather than refusing it", () => {
    const pieces = splitText("あ".repeat(500), 100, 1);
    expect(pieces.length).toBeGreaterThanOrEqual(5);
    expect(pieces.join("")).toBe("あ".repeat(500));
  });
});

describe("cleanSynopsis", () => {
  it("unwraps a code fence and trims", () => {
    expect(cleanSynopsis("```markdown\nHello **there**.\n```\n")).toBe("Hello **there**.");
    expect(cleanSynopsis("  plain  ")).toBe("plain");
  });
});

describe("summarizeChapter", () => {
  it("is one call when the chapter fits", async () => {
    const { deps, sent } = fakeDeps();
    const r = await summarizeChapter({ chapter: ch("c1"), system: "SYS", index: 0, deps, signal: signal() });
    expect(sent).toHaveLength(1);
    expect(sent[0].system).toBe("SYS");
    expect(sent[0].user).toContain('<chapter title="c1">');
    expect(r).toMatchObject({ markdown: "synopsis of c1", parts: 1 });
  });

  it("splits a long chapter, summarizes the parts, then merges", async () => {
    const text = Array.from({ length: 30 }, (_, i) => `${"あ".repeat(20)}${i}`).join("\n");
    const { deps, sent } = fakeDeps({ maxInputTokens: 700 }, (s) =>
      s.system.includes("consecutive parts") ? "MERGED" : "partial",
    );
    const r = await summarizeChapter({
      chapter: { id: "c", title: "c", text },
      system: "S".repeat(10),
      index: 0,
      deps,
      signal: signal(),
    });
    expect(r.parts).toBeGreaterThan(1);
    expect(sent).toHaveLength(r.parts + 1);
    expect(sent.slice(0, -1).every((s) => s.system.includes("too long to send at once"))).toBe(true);
    expect(sent[sent.length - 1].user).toContain("Part 1:\npartial");
    expect(r.markdown).toBe("MERGED");
  });

  it("merges in rounds when the partial synopses do not fit one call", async () => {
    const text = Array.from({ length: 90 }, (_, i) => `${"あ".repeat(20)}${i}`).join("\n");
    // Partials long enough that only two fit one merge call.
    const { deps, sent } = fakeDeps({ maxInputTokens: 700 }, (s) =>
      s.system.includes("consecutive parts") ? "MERGED" : "あ".repeat(200),
    );
    const r = await summarizeChapter({
      chapter: { id: "c", title: "c", text },
      system: "S".repeat(10),
      index: 0,
      deps,
      signal: signal(),
    });
    const merges = sent.filter((s) => s.system.includes("consecutive parts"));
    expect(merges.length).toBeGreaterThan(1);
    expect(merges.every((m) => m.user.length < 700)).toBe(true);
    expect(r.markdown).toBe("MERGED");
  });

  it("sends the previous synopsis as context, tagged", async () => {
    const { deps, sent } = fakeDeps();
    await summarizeChapter({
      chapter: ch("c2"),
      previous: { title: "c1", markdown: "what came before" },
      system: "S",
      index: 1,
      deps,
      signal: signal(),
    });
    expect(sent[0].user).toMatch(/^<previous_synopsis chapter="c1">\nwhat came before\n<\/previous_synopsis>/);
  });
});

describe("summarizeDoc", () => {
  const run = (doc: SummaryDoc, over: Partial<Parameters<typeof summarizeDoc>[0]> = {}) => {
    const landed: [string, string][] = [];
    return {
      landed,
      args: {
        doc,
        ids: new Set(doc.chapters.map((c) => c.id)),
        existing: new Map<string, string>(),
        carryOver: true,
        system: "S",
        onChapter: (id: string, r: { markdown: string }) => void landed.push([id, r.markdown]),
        ...over,
      },
    };
  };

  it("carries each synopsis into the next chapter, in order", async () => {
    const { deps, sent } = fakeDeps();
    const { args, landed } = run(docOf("a", "b", "c"));
    await summarizeDoc(args, deps, signal());
    expect(landed.map(([id]) => id)).toEqual(["a", "b", "c"]);
    expect(sent[0].user).not.toContain("<previous_synopsis");
    expect(sent[1].user).toContain("synopsis of a");
    expect(sent[2].user).toContain("synopsis of b");
  });

  it("leaves the previous chapter out when carry-over is off", async () => {
    const { deps, sent } = fakeDeps();
    await summarizeDoc(run(docOf("a", "b", "c"), { carryOver: false }).args, deps, signal());
    expect(sent).toHaveLength(3);
    expect(sent.every((s) => !s.user.includes("<previous_synopsis"))).toBe(true);
  });

  it("runs independent chapters concurrently", async () => {
    let inFlight = 0;
    let peak = 0;
    const { deps } = fakeDeps({
      chat: async () => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { content: "ok", finishReason: "stop", status: 200, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      },
    });
    await summarizeDoc(run(docOf("a", "b", "c", "d", "e"), { carryOver: false }).args, deps, signal());
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("never overlaps chapters when carrying over", async () => {
    let inFlight = 0;
    let peak = 0;
    const { deps } = fakeDeps({
      chat: async () => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
        return { content: "ok", finishReason: "stop", status: 200, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      },
    });
    await summarizeDoc(run(docOf("a", "b", "c")).args, deps, signal());
    expect(peak).toBe(1);
  });

  it("only runs the chosen chapters, but still carries over stored neighbours", async () => {
    const { deps, sent } = fakeDeps();
    const { args, landed } = run(docOf("a", "b", "c"), {
      ids: new Set(["c"]),
      existing: new Map([["b", "stored b"]]),
    });
    await summarizeDoc(args, deps, signal());
    expect(landed.map(([id]) => id)).toEqual(["c"]);
    expect(sent).toHaveLength(1);
    expect(sent[0].user).toContain("stored b");
  });

  it("does not carry a stored synopsis over a chapter that just failed", async () => {
    const { deps, sent } = fakeDeps({}, (s) =>
      s.user.includes('title="b"') ? new LlmError("empty reply", 200, true) : "fine",
    );
    const { args } = run(docOf("a", "b", "c"), {
      ids: new Set(["b", "c"]),
      existing: new Map([["b", "OLD B"]]),
    });
    await summarizeDoc(args, deps, signal());
    const forC = sent.find((s) => s.user.includes('title="c"'));
    expect(forC?.user).not.toContain("OLD B");
  });

  it("reports a non-fatal failure and carries on", async () => {
    const { deps, events } = fakeDeps({}, (s) =>
      s.user.includes('title="b"') ? new LlmError("empty reply", 200, true) : "fine",
    );
    const { args, landed } = run(docOf("a", "b", "c"));
    const r = await summarizeDoc(args, deps, signal());
    expect(r).toEqual({ done: 2, failed: 1 });
    expect(landed.map(([id]) => id)).toEqual(["a", "c"]);
    expect(events.some((e) => e.type === "chapter-failed" && e.id === "b")).toBe(true);
  });

  it("stops on a fatal error and keeps what already landed", async () => {
    const { deps, sent } = fakeDeps({}, (s) =>
      s.user.includes('title="b"') ? new LlmError("bad key", 401, false) : "fine",
    );
    const { args, landed } = run(docOf("a", "b", "c"));
    await expect(summarizeDoc(args, deps, signal())).rejects.toThrow("bad key");
    expect(landed.map(([id]) => id)).toEqual(["a"]);
    expect(sent).toHaveLength(2);
  });

  it("does not call the endpoint when the quota has no room", async () => {
    const { deps, sent } = fakeDeps({
      limiter: { ...openQuota, check: () => ({ waitMs: 1000, reason: "rpd" as const }) },
    });
    await expect(summarizeDoc(run(docOf("a")).args, deps, signal())).rejects.toThrow(/Daily request quota/);
    expect(sent).toHaveLength(0);
  });

  it("stops promptly when aborted", async () => {
    const ac = new AbortController();
    const { deps } = fakeDeps();
    ac.abort(new Error("stopped"));
    await expect(summarizeDoc(run(docOf("a", "b")).args, deps, ac.signal)).rejects.toThrow("stopped");
  });
});

describe("planSummary", () => {
  const o = { systemTokens: 100, charsPerToken: 1, maxInputTokens: 1000, carryOver: true };

  it("counts one call per chapter that fits", () => {
    const doc = docOf("a", "b", "c");
    expect(planSummary(doc, new Set(["a", "b"]), o).calls).toBe(2);
  });

  it("counts the parts and the merge for a long chapter", () => {
    const doc: SummaryDoc = {
      ...docOf(),
      chapters: [{ id: "long", title: "long", text: Array.from({ length: 100 }, () => "あ".repeat(30)).join("\n") }],
    };
    const plan = planSummary(doc, new Set(["long"]), o);
    expect(plan.longChapters).toEqual(["long"]);
    expect(plan.calls).toBeGreaterThan(2);
  });
});
