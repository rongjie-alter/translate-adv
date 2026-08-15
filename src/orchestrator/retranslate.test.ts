import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LlmError, type ChatResponse } from "../llm/client";
import { RateLimiter, emptyState, type Availability, type Quota } from "../llm/limiter";
import { DEFAULT_SYSTEM_PROMPT } from "../llm/prompt";
import { makeLabelMap } from "../scenario/labels";
import { parseBookHtml } from "../scenario/parseHtml";
import {
  applyTranslations,
  artifactLabelIds,
  artifactNodes,
  artifactSpeakers,
  buildArtifact,
  type Artifact,
} from "../storage/exchange";
import {
  planRetranslate,
  runRetranslate,
  type RetranslateEvent,
  type RetranslateDeps,
} from "./retranslate";

const book = parseBookHtml(
  "touroumatsuri2026.book.html",
  readFileSync("book/touroumatsuri2026.book.html", "utf8"),
);
const chapter = book.chapters[0];

/** A fully translated artifact, so context lines have something to carry. */
const translated = buildArtifact({
  book: "touroumatsuri2026.book.html",
  srcHash: book.srcHash,
  chapter,
  lang: "en",
  model: "mock",
  translations: new Map(
    chapter.nodes.flatMap((n) => ("uid" in n ? [[n.uid, `[EN] ${n.src}`] as const] : [])),
  ),
  generatedAt: 1000,
});

const labels = makeLabelMap(artifactLabelIds(translated));

function plan(a: Artifact, uids: string[], over: Partial<Parameters<typeof planRetranslate>[1]> = {}) {
  return planRetranslate(
    { artifact: a, uids },
    {
      labels,
      lang: "en",
      systemTokens: 400,
      charsPerToken: 1,
      outputRatio: 0.9,
      maxInputTokens: 8000,
      maxOutputTokens: 4000,
      ...over,
    },
  );
}

/** Numbered lines only — what the model is actually asked to answer. */
function numbered(text: string): string[] {
  return text.split("\n").filter((l) => /^\d+ /.test(l));
}

function contextLines(text: string): string[] {
  return text.split("\n").filter((l) => l.startsWith("~ "));
}

describe("artifact round trip", () => {
  it("rebuilds the node list a chapter was serialized from", () => {
    const nodes = artifactNodes(translated);
    expect(nodes.map((n) => n.kind)).toEqual(chapter.nodes.map((n) => n.kind));
    const uids = (ns: typeof nodes) => ns.flatMap((n) => ("uid" in n ? [n.uid] : []));
    expect(uids(nodes)).toEqual(uids(chapter.nodes));
  });

  it("recovers the speaker glossary without the source book", () => {
    expect(artifactSpeakers(translated).length).toBeGreaterThan(0);
    expect(artifactSpeakers(translated).every((s) => !!s.jp)).toBe(true);
  });
});

describe("planRetranslate", () => {
  it("numbers only the selected lines, and sends the rest as context", () => {
    const target = translated.units[20];
    const p = plan(translated, [target.id]);

    expect(p.requests).toHaveLength(1);
    const [req] = p.requests;
    expect(req.uids).toEqual([target.id]);
    expect(numbered(req.wire.text)).toHaveLength(1);
    expect(req.wire.lines.map((l) => l.uid)).toEqual([target.id]);
    expect(contextLines(req.wire.text).length).toBeGreaterThan(0);
    expect(p.contextUids).not.toContain(target.id);
  });

  it("carries the existing translation as context, not the Japanese", () => {
    const p = plan(translated, [translated.units[20].id]);
    // Every context line should be the `[EN] …` text this fixture was filled with.
    expect(contextLines(p.requests[0].wire.text).every((l) => l.includes("[EN]"))).toBe(true);
  });

  it("falls back to the Japanese when a neighbour was never translated", () => {
    const partial: Artifact = {
      ...translated,
      units: translated.units.map((u, i) => (i === 19 ? { ...u, tl: "" } : u)),
    };
    const p = plan(partial, [partial.units[20].id]);
    const ctx = contextLines(p.requests[0].wire.text);
    expect(ctx.some((l) => l === `~ ${partial.units[19].src}`)).toBe(true);
  });

  it("brings preceding and following context around a target", () => {
    const i = 40;
    const p = plan(translated, [translated.units[i].id]);
    const ctx = contextLines(p.requests[0].wire.text).join("\n");
    expect(ctx).toContain(translated.units[i - 1].tl);
    expect(ctx).toContain(translated.units[i + 1].tl); // the runner can never do this
  });

  it("merges nearby selections into one group instead of repeating context", () => {
    const a = translated.units[30].id;
    const b = translated.units[32].id; // one unit apart — inside mergeGap
    const p = plan(translated, [a, b]);

    expect(p.requests).toHaveLength(1);
    expect(p.requests[0].wire.text).not.toContain("[...]");
    // The unit between them rides along as context, and is not retranslated.
    expect(p.requests[0].uids).toEqual([a, b]);
    expect(p.contextUids).toContain(translated.units[31].id);
  });

  it("separates distant selections with a gap marker", () => {
    const a = translated.units[10].id;
    const b = translated.units[60].id;
    const p = plan(translated, [a, b]);

    expect(p.requests).toHaveLength(1);
    const gaps = p.requests[0].wire.text.split("\n").filter((l) => l === "~ [...]");
    expect(gaps).toHaveLength(1);
    expect(numbered(p.requests[0].wire.text)).toHaveLength(2);
  });

  it("never emits the same unit twice when windows would overlap", () => {
    const p = plan(translated, [translated.units[20].id, translated.units[26].id]);
    const body = p.requests.map((r) => r.wire.text).join("\n");
    const counts = new Map<string, number>();
    for (const line of body.split("\n")) counts.set(line, (counts.get(line) ?? 0) + 1);
    const dupes = [...counts].filter(([l, n]) => n > 1 && l.startsWith("~ ") && l !== "~ [...]");
    expect(dupes).toEqual([]);
  });

  it("numbers ascending across group boundaries so one parse maps them all", () => {
    const ids = [8, 40, 80].map((i) => translated.units[i].id);
    const p = plan(translated, ids);
    const ns = numbered(p.requests[0].wire.text).map((l) => Number(l.split(" ")[0]));
    expect(ns).toEqual([1, 2, 3]);
    expect(p.requests[0].wire.lines.map((l) => l.uid)).toEqual(ids);
  });

  it("emits the enclosing label so the model knows which branch it is in", () => {
    const p = plan(translated, [translated.units[20].id]);
    const structure = p.requests[0].wire.text.split("\n").filter((l) => l.startsWith("== "));
    expect(structure).toHaveLength(1);
    expect(structure[0]).toMatch(/^== \S+ ==$/);
  });

  it("restates the label for a group whose window does not contain one", () => {
    // Two distant groups: each must be oriented independently.
    const ids = [20, 200].map((i) => translated.units[i].id).filter(Boolean);
    const p = plan(translated, ids);
    const labelsEmitted = p.requests
      .flatMap((r) => r.wire.text.split("\n"))
      .filter((l) => l.startsWith("== "));
    expect(labelsEmitted.length).toBeGreaterThanOrEqual(2);
  });

  it("reports ids that are not in the artifact instead of dropping them", () => {
    const p = plan(translated, ["nope/1", translated.units[3].id]);
    expect(p.unknown).toEqual(["nope/1"]);
    expect(p.requests[0].uids).toEqual([translated.units[3].id]);
  });

  it("returns nothing for an empty selection", () => {
    expect(plan(translated, []).requests).toEqual([]);
  });

  it("packs many scattered lines into a single call when they fit", () => {
    const ids = [5, 25, 45, 65, 85].map((i) => translated.units[i].id);
    const p = plan(translated, ids);
    expect(p.requests).toHaveLength(1);
    expect(p.requests[0].uids).toEqual(ids);
  });

  it("splits into more calls when the output cap binds", () => {
    const ids = [5, 25, 45, 65, 85].map((i) => translated.units[i].id);
    const one = plan(translated, ids, { maxOutputTokens: 4000 });
    const many = plan(translated, ids, { maxOutputTokens: 60 });
    expect(one.requests).toHaveLength(1);
    expect(many.requests.length).toBeGreaterThan(1);
    // Every selected line still gets asked for exactly once.
    expect(many.requests.flatMap((r) => r.uids).sort()).toEqual([...ids].sort());
  });

  it("weighs input and output separately, so context does not force a split", () => {
    const ids = [5, 25, 45].map((i) => translated.units[i].id);
    // Output budget is ample; input budget is what a naive combined budget would cut on.
    const p = plan(translated, ids, { maxOutputTokens: 4000, maxInputTokens: 8000 });
    expect(p.requests).toHaveLength(1);
    const req = p.requests[0];
    // Context dominates the body — that is the whole point of splitting the budgets.
    expect(contextLines(req.wire.text).length).toBeGreaterThan(numbered(req.wire.text).length);
    expect(req.outputTokens).toBeLessThan(req.inputTokens);
  });

  it("still makes progress when one line exceeds the whole budget", () => {
    const huge: Artifact = {
      ...translated,
      units: translated.units.map((u, i) =>
        i === 12 ? { ...u, src: "あ".repeat(5000), tl: "x" } : u,
      ),
    };
    const p = plan(huge, [huge.units[12].id], { maxOutputTokens: 100, maxInputTokens: 500 });
    expect(p.requests).toHaveLength(1);
    expect(p.requests[0].uids).toEqual([huge.units[12].id]);
  });
});

describe("runRetranslate", () => {
  function setup(over: Partial<RetranslateDeps> = {}) {
    const saved: { next: Map<string, string>; previous: Map<string, string> }[] = [];
    const events: RetranslateEvent[] = [];
    const deps: RetranslateDeps = {
      limiter: new RateLimiter(
        { rpm: 0, rpd: 0, tpm: 0, maxInputTokens: 0, maxOutputTokens: 0 },
        "UTC",
        emptyState(),
      ),
      apiKey: "k",
      baseUrl: "http://mock",
      model: "other-model",
      maxOutputTokens: 4000,
      maxInputTokens: 8000,
      systemPromptTemplate: DEFAULT_SYSTEM_PROMPT,
      speakers: artifactSpeakers(translated),
      labels,
      lang: "en",
      calibration: { charsPerToken: 1, outputRatio: 0.9, samples: 0 },
      saveUnits: async (next, previous) => {
        saved.push({ next: new Map(next), previous: new Map(previous) });
      },
      onCalibration: () => {},
      onEvent: (e) => events.push(e),
      chat: echoChat(),
      ...over,
    };
    return { deps, saved, events };
  }

  it("returns only the selected lines, never the context", async () => {
    const ids = [10, 40].map((i) => translated.units[i].id);
    const { deps } = setup();
    const res = await runRetranslate(
      { artifact: translated, uids: ids },
      deps,
      new AbortController().signal,
    );

    expect([...res.translations.keys()].sort()).toEqual([...ids].sort());
    expect(res.failedRequests).toBe(0);
    expect(res.usage.requests).toBe(1);
  });

  it("records what each line said before, for the accept step", async () => {
    const id = translated.units[10].id;
    const { deps } = setup();
    const res = await runRetranslate(
      { artifact: translated, uids: [id] },
      deps,
      new AbortController().signal,
    );
    expect(res.previous.get(id)).toBe(translated.units[10].tl);
    expect(res.translations.get(id)).not.toBe(translated.units[10].tl);
  });

  it("persists each request before sending the next", async () => {
    const ids = [5, 25, 45, 65].map((i) => translated.units[i].id);
    const { deps, saved } = setup({ maxOutputTokens: 60 });
    await runRetranslate({ artifact: translated, uids: ids }, deps, new AbortController().signal);
    expect(saved.length).toBeGreaterThan(1);
    expect(saved.flatMap((s) => [...s.next.keys()]).sort()).toEqual([...ids].sort());
  });

  it("waits for quota and never sends without reserving", async () => {
    const order: string[] = [];
    const quota: Quota = {
      check: (): Availability => ({ waitMs: 0 }),
      reserve: () => order.push("reserve"),
      settle: () => order.push("settle"),
      penalize: () => {},
    };
    const { deps } = setup({
      limiter: quota,
      chat: async (req) => {
        order.push("send");
        return echoChat()(req);
      },
    });
    await runRetranslate(
      { artifact: translated, uids: [translated.units[10].id] },
      deps,
      new AbortController().signal,
    );
    expect(order).toEqual(["reserve", "send", "settle"]);
  });

  it("recovers lines the model dropped", async () => {
    const ids = [10, 11, 12].map((i) => translated.units[i].id);
    const { deps, events } = setup({ chat: echoChat({ dropFirstLineOnce: true }) });
    const res = await runRetranslate(
      { artifact: translated, uids: ids },
      deps,
      new AbortController().signal,
    );
    expect(events.some((e) => e.type === "repair")).toBe(true);
    expect([...res.translations.keys()].sort()).toEqual([...ids].sort());
  });

  it("never blanks an existing translation when the model returns nothing", async () => {
    const id = translated.units[10].id;
    const { deps } = setup({
      chat: async () => ({
        content: "",
        finishReason: "stop",
        usage: { promptTokens: 1, completionTokens: 0, totalTokens: 1 },
      }),
    });
    const res = await runRetranslate(
      { artifact: translated, uids: [id] },
      deps,
      new AbortController().signal,
    );
    expect(res.translations.size).toBe(0);
    expect(res.missing).toContain(id);
  });

  it("stops on an exhausted daily quota rather than failing every request", async () => {
    const ids = [5, 25, 45, 65].map((i) => translated.units[i].id);
    let calls = 0;
    const { deps, events } = setup({
      maxOutputTokens: 60,
      chat: async (req) => {
        calls++;
        if (calls > 1) throw new LlmError("out of quota", 429, false);
        return echoChat()(req);
      },
    });
    const res = await runRetranslate(
      { artifact: translated, uids: ids },
      deps,
      new AbortController().signal,
    );
    expect(res.failedRequests).toBe(1);
    expect(calls).toBe(2); // stopped instead of burning the rest
    expect(events.some((e) => e.type === "request-failed")).toBe(true);
  });

  it("throws when aborted", async () => {
    const { deps } = setup();
    const ac = new AbortController();
    ac.abort(new Error("stopped by user"));
    await expect(
      runRetranslate({ artifact: translated, uids: [translated.units[10].id] }, deps, ac.signal),
    ).rejects.toThrow();
  });
});

describe("applyTranslations", () => {
  it("replaces only the named units and leaves everything else identical", () => {
    const id = translated.units[10].id;
    const next = applyTranslations(translated, new Map([[id, "fixed"]]), {
      model: "mock",
      at: 2000,
    });
    expect(next.units[10].tl).toBe("fixed");
    expect(next.units.filter((_, i) => i !== 10)).toEqual(
      translated.units.filter((_, i) => i !== 10),
    );
    expect(next.generatedAt).toBe(2000);
  });

  it("stamps a per-line model only when it differs from the chapter's", () => {
    const id = translated.units[10].id;
    const other = applyTranslations(translated, new Map([[id, "x"]]), {
      model: "other-model",
      at: 1,
    });
    expect(other.units[10].model).toBe("other-model");
    expect(other.model).toBe("mock"); // the chapter's own model is left alone

    const back = applyTranslations(other, new Map([[id, "y"]]), { model: "mock", at: 2 });
    expect(back.units[10].model).toBeUndefined();
  });

  it("recomputes the incomplete list", () => {
    const withHole: Artifact = {
      ...translated,
      units: translated.units.map((u, i) => (i === 5 ? { ...u, tl: "" } : u)),
      incomplete: [translated.units[5].id],
    };
    const filled = applyTranslations(withHole, new Map([[withHole.units[5].id, "done"]]), {
      model: "mock",
      at: 3,
    });
    expect(filled.incomplete).toBeUndefined();
  });
});

/** Stand-in endpoint: echoes each numbered line back with a prefix. */
function echoChat(opts: { dropFirstLineOnce?: boolean } = {}) {
  let dropped = false;
  return async (req: { system: string; user: string }): Promise<ChatResponse> => {
    const lines = req.user
      .split("\n")
      .map((l) => /^(\d+) (?:>\S+ |# )?(?:[^:：]{1,24}[:：] )?(.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => `${m[1]} [RETRY] ${m[2]}`);
    const dropNow = opts.dropFirstLineOnce && !dropped;
    if (dropNow) dropped = true;
    const body = dropNow ? lines.slice(1) : lines;
    const completionTokens = body.join("\n").length;
    return {
      content: body.join("\n"),
      finishReason: "stop",
      usage: {
        promptTokens: req.user.length,
        completionTokens,
        totalTokens: req.user.length + completionTokens,
      },
    };
  };
}
