import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LlmError, type ChatResponse } from "../llm/client";
import { calibrate, estimateJob, estimateTokens } from "../llm/estimate";
import { emptyState, RateLimiter } from "../llm/limiter";
import { DEFAULT_SYSTEM_PROMPT, buildSystemPrompt } from "../llm/prompt";
import { makeLabelMap } from "../scenario/labels";
import { isTranslatable, type SceneNode } from "../scenario/model";
import { chapterSpeakers, parseBookHtml } from "../scenario/parseHtml";
import { chunkNodes } from "./chunker";
import { jobId, type Job } from "./job";
import { runJob, type RunEvent } from "./runner";

const book = parseBookHtml(
  "touroumatsuri2026.book.html",
  readFileSync("book/touroumatsuri2026.book.html", "utf8"),
);
const chapter = book.chapters[0];

const OPTS = {
  maxInputTokens: 4000,
  maxOutputTokens: 2000,
  charsPerToken: 1,
  outputRatio: 0.9,
  systemTokens: 400,
};

describe("estimateTokens", () => {
  it("counts Japanese far denser than Latin", () => {
    const jp = estimateTokens("こんにちは世界", 1);
    const en = estimateTokens("hello world hi", 1);
    expect(jp).toBe(7);
    expect(en).toBeLessThan(jp);
  });

  it("calibrates towards the observed tokenizer", () => {
    let cal = { charsPerToken: 4, outputRatio: 0.9, samples: 0 };
    const promptText = "あ".repeat(1000);
    for (let i = 0; i < 8; i++) {
      cal = calibrate(cal, {
        promptText,
        promptTokens: 1000,
        sourceTokens: 1000,
        completionTokens: 700,
      });
    }
    expect(cal.charsPerToken).toBeCloseTo(1, 1);
    expect(cal.outputRatio).toBeCloseTo(0.7, 1);
  });

  it("reports calls, tokens and whether the daily quota blocks the job", () => {
    const est = estimateJob({
      chunkTexts: ["あ".repeat(500), "あ".repeat(500)],
      systemPrompt: "sys",
      charsPerToken: 1,
      outputRatio: 0.8,
      rpm: 10,
      rpd: 250,
      requestsUsedToday: 249,
    });
    expect(est.calls).toBe(2);
    expect(est.inputTokens).toBeGreaterThan(1000);
    expect(est.outputTokens).toBe(800);
    expect(est.exceedsDaily).toBe(true);
    expect(est.minSeconds).toBeCloseTo(6, 0);
  });
});

describe("chunkNodes", () => {
  const chunks = chunkNodes(chapter.nodes, OPTS);

  it("covers every translatable unit exactly once, in order", () => {
    const all = chapter.nodes.filter(isTranslatable).map((n) => n.uid);
    const chunked = chunks.flatMap((c) => c.nodes.filter(isTranslatable).map((n) => n.uid));
    expect(chunked).toEqual(all);
  });

  it("keeps every chunk inside the budget", () => {
    const budget = Math.floor((OPTS.maxOutputTokens * 0.85) / OPTS.outputRatio);
    // A chunk may overshoot only if one indivisible line is itself oversized.
    for (const c of chunks) expect(c.tokens).toBeLessThanOrEqual(budget * 1.35);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("never splits a run of branch options", () => {
    for (const c of chunks) {
      const last = c.nodes[c.nodes.length - 1];
      const first = c.nodes[0];
      if (last?.kind === "select") {
        // if a chunk ends on an option, the next must not begin with one
        const i = chunks.indexOf(c);
        expect(chunks[i + 1]?.nodes[0]?.kind).not.toBe("select");
      }
      expect(first).toBeDefined();
    }
  });

  it("never splits inside a conditional block", () => {
    for (const c of chunks) {
      let depth = 0;
      for (const n of c.nodes) {
        if (n.kind === "cond") depth++;
        if (n.kind === "cond-end") depth--;
      }
      expect(depth).toBe(0);
    }
  });

  it("prefers to start a chunk at a branch label", () => {
    const starts = chunks.slice(1).filter((c) => c.nodes[0].kind === "label").length;
    expect(starts).toBeGreaterThan(0);
  });

  it("shrinks the budget when the output cap binds", () => {
    const tight = chunkNodes(chapter.nodes, { ...OPTS, maxOutputTokens: 500 });
    expect(tight.length).toBeGreaterThan(chunks.length);
  });

  it("emits a single chunk for a short chapter", () => {
    const few = chapter.nodes.slice(0, 6);
    expect(chunkNodes(few, OPTS)).toHaveLength(1);
  });

  it("makes progress even when one line exceeds the whole budget", () => {
    const huge: SceneNode[] = [
      { kind: "text", uid: "a/1", src: "あ".repeat(5000), hash: "x" },
      { kind: "text", uid: "a/2", src: "short", hash: "y" },
    ];
    const out = chunkNodes(huge, { ...OPTS, maxInputTokens: 600, maxOutputTokens: 600 });
    expect(out.flatMap((c) => c.nodes)).toHaveLength(2);
  });
});

describe("RateLimiter", () => {
  const limits = { rpm: 2, rpd: 3, tpm: 1000, maxInputTokens: 0, maxOutputTokens: 0 };

  it("blocks once the per-minute request count is reached", () => {
    let now = 1_000_000;
    const l = new RateLimiter(limits, "UTC", emptyState(), () => {}, () => now);
    expect(l.check(10).waitMs).toBe(0);
    l.reserve(10);
    l.reserve(10);
    const blocked = l.check(10);
    expect(blocked.reason).toBe("rpm");
    expect(blocked.waitMs).toBeGreaterThan(0);

    now += 61_000;
    expect(l.check(10).waitMs).toBe(0);
  });

  it("blocks on tokens per minute", () => {
    const now = 1_000_000;
    const l = new RateLimiter({ ...limits, rpm: 0 }, "UTC", emptyState(), () => {}, () => now);
    l.reserve(900);
    expect(l.check(200).reason).toBe("tpm");
    expect(l.check(50).waitMs).toBe(0);
  });

  it("reports rpd separately, since waiting will not help today", () => {
    let now = Date.UTC(2026, 0, 1, 10, 0, 0);
    const l = new RateLimiter({ ...limits, rpm: 0 }, "UTC", emptyState(), () => {}, () => now);
    l.reserve(1);
    l.reserve(1);
    l.reserve(1);
    const blocked = l.check(1);
    expect(blocked.reason).toBe("rpd");
    expect(blocked.waitMs).toBeGreaterThan(13 * 3600_000);

    now += 24 * 3600_000;
    expect(l.check(1).waitMs).toBe(0);
    expect(l.usage.rpdUsed).toBe(0);
  });

  it("honours a 429 Retry-After", () => {
    const now = 1_000_000;
    const l = new RateLimiter({ ...limits, rpm: 0, rpd: 0 }, "UTC", emptyState(), () => {}, () => now);
    l.penalize(30);
    expect(l.check(1)).toEqual({ waitMs: 30_000, reason: "backoff" });
  });

  it("corrects the reservation once real usage is known", () => {
    const now = 1_000_000;
    const l = new RateLimiter({ ...limits, rpm: 0 }, "UTC", emptyState(), () => {}, () => now);
    l.reserve(100);
    l.settle(100, 250);
    expect(l.usage.tpmUsed).toBe(250);
  });
});

describe("runJob", () => {
  const nodes = chapter.nodes.slice(0, 120);
  const speakers = chapterSpeakers(chapter);
  const labels = makeLabelMap(
    chapter.nodes.flatMap((n) => (n.kind === "label" ? [n.id] : n.kind === "jump" ? [n.to] : [])),
  );

  function setup(overrides: Partial<Parameters<typeof runJob>[3]> = {}) {
    const chunks = chunkNodes(nodes, { ...OPTS, maxInputTokens: 1200, maxOutputTokens: 800 });
    const job: Job = {
      id: jobId("b.html", chapter.name, "en"),
      bookFile: "b.html",
      srcHash: book.srcHash,
      chapter: chapter.name,
      lang: "en",
      presetId: "mock",
      model: "mock",
      chunks: chunks.map((c, i) => ({
        index: i,
        uids: c.nodes.filter(isTranslatable).map((n) => n.uid),
        status: "pending" as const,
        attempts: 0,
      })),
      usage: { requests: 0, promptTokens: 0, completionTokens: 0 },
      createdAt: 0,
      updatedAt: 0,
    };
    const saved = new Map<string, string>();
    const events: RunEvent[] = [];
    const deps = {
      limiter: new RateLimiter(
        { rpm: 0, rpd: 0, tpm: 0, maxInputTokens: 0, maxOutputTokens: 0 },
        "UTC",
      ),
      apiKey: "k",
      baseUrl: "http://mock",
      model: "mock",
      maxOutputTokens: 800,
      systemPromptTemplate: DEFAULT_SYSTEM_PROMPT,
      speakers,
      labels,
      calibration: { charsPerToken: 1, outputRatio: 0.9, samples: 0 },
      saveUnits: async (_c: unknown, t: Map<string, string>) => {
        for (const [k, v] of t) saved.set(k, v);
      },
      saveJob: async () => {},
      onCalibration: () => {},
      onEvent: (e: RunEvent) => events.push(e),
      chat: echoChat(),
      ...overrides,
    };
    return { chunks, job, deps, saved, events };
  }

  it("translates every unit and records usage", async () => {
    const { chunks, job, deps, saved } = setup();
    await runJob(job, chunks, "en", deps, new AbortController().signal);

    const expected = nodes.filter(isTranslatable).map((n) => n.uid);
    expect([...saved.keys()].sort()).toEqual([...expected].sort());
    expect(job.chunks.every((c) => c.status === "done")).toBe(true);
    expect(job.usage.requests).toBe(chunks.length);
    expect(job.usage.completionTokens).toBeGreaterThan(0);
  });

  it("skips chunks already done, so a resumed job only pays for the rest", async () => {
    const { chunks, job, deps, events } = setup();
    job.chunks[0].status = "done";
    await runJob(job, chunks, "en", deps, new AbortController().signal);
    const started = events.filter((e) => e.type === "chunk-start").map((e) => e.index);
    expect(started).not.toContain(0);
    expect(job.usage.requests).toBe(chunks.length - 1);
  });

  it("repairs lines the model dropped", async () => {
    const { chunks, job, deps, saved, events } = setup({ chat: echoChat({ dropFirstLineOnce: true }) });
    await runJob(job, chunks, "en", deps, new AbortController().signal);
    expect(events.some((e) => e.type === "repair")).toBe(true);
    const expected = nodes.filter(isTranslatable).map((n) => n.uid);
    expect(saved.size).toBe(expected.length);
  });

  it("keeps the good lines and warns when repair cannot recover a line", async () => {
    // Adversarial endpoint: drops a line from every reply, including the repairs.
    const { chunks, job, deps, saved } = setup({ chat: echoChat({ dropFirstLine: true }) });
    await runJob(job, chunks, "en", deps, new AbortController().signal);
    expect(job.chunks.every((c) => c.status === "done")).toBe(true);
    expect(job.chunks.filter((c) => c.missing?.length).length).toBe(chunks.length);
    expect(job.warnings?.length).toBe(chunks.length);
    // Everything else still landed — one bad line does not cost the chunk.
    const expected = nodes.filter(isTranslatable).length;
    expect(saved.size).toBe(expected - chunks.length);
  });

  it("retries a transient failure, then succeeds", async () => {
    let calls = 0;
    const flaky = async (req: Parameters<typeof deps.chat>[0]): Promise<ChatResponse> => {
      if (++calls === 1) throw new LlmError("boom", 503, true);
      return echoChat()(req);
    };
    const { chunks, job, deps, events } = setup({ chat: flaky });
    await runJob(job, chunks, "en", deps, new AbortController().signal);
    expect(events.some((e) => e.type === "retry")).toBe(true);
    expect(job.chunks.every((c) => c.status === "done")).toBe(true);
  });

  it("stops early on a fatal error instead of burning quota on every chunk", async () => {
    const dead = async (): Promise<ChatResponse> => {
      throw new LlmError("bad key", 401, false);
    };
    const { chunks, job, deps } = setup({ chat: dead });
    await runJob(job, chunks, "en", deps, new AbortController().signal);
    expect(job.chunks[0].status).toBe("failed");
    expect(job.chunks.filter((c) => c.status === "failed")).toHaveLength(1);
    expect(job.chunks.filter((c) => c.status === "pending").length).toBeGreaterThan(0);
  });

  it("waits for quota before sending, and never sends without reserving", async () => {
    const { chunks, job, deps, events } = setup();
    const order: string[] = [];
    let throttleOnce = true;
    deps.limiter = {
      check: () => (throttleOnce ? ((throttleOnce = false), { waitMs: 5, reason: "rpm" as const }) : { waitMs: 0 }),
      reserve: () => order.push("reserve"),
      settle: () => {},
      penalize: () => {},
    };
    deps.chat = async (req) => {
      order.push("send");
      return echoChat()(req);
    };

    await runJob(job, chunks, "en", deps, new AbortController().signal);

    expect(events.some((e) => e.type === "waiting" && e.reason === "rpm")).toBe(true);
    expect(order.slice(0, 2)).toEqual(["reserve", "send"]);
    expect(order.filter((o) => o === "reserve").length).toBe(order.filter((o) => o === "send").length);
    expect(job.chunks.every((c) => c.status === "done")).toBe(true);
  });

  it("gives up for the day rather than spinning when the daily quota is gone", async () => {
    const { chunks, job, deps } = setup();
    deps.limiter = {
      check: () => ({ waitMs: 3600_000, reason: "rpd" as const }),
      reserve: () => {},
      settle: () => {},
      penalize: () => {},
    };
    deps.chat = async () => {
      throw new Error("should not have been called");
    };
    await runJob(job, chunks, "en", deps, new AbortController().signal);
    expect(job.chunks[0].status).toBe("failed");
    expect(job.chunks[0].error).toMatch(/Daily request quota/);
    expect(job.chunks.filter((c) => c.status === "pending").length).toBeGreaterThan(0);
  });

  it("aborts promptly when cancelled", async () => {
    const { chunks, job, deps } = setup();
    const ac = new AbortController();
    ac.abort(new Error("stopped"));
    await expect(runJob(job, chunks, "en", deps, ac.signal)).rejects.toThrow("stopped");
  });

  it("sends short label aliases and a glossary, never raw label ids", async () => {
    const seen: string[] = [];
    const spy = async (req: Parameters<typeof deps.chat>[0]): Promise<ChatResponse> => {
      seen.push(req.system + "\n" + req.user);
      return echoChat()(req);
    };
    const { chunks, job, deps } = setup({ chat: spy });
    await runJob(job, chunks, "en", deps, new AbortController().signal);
    expect(seen[0]).not.toContain("quest_evMain_touroumatsuri2026");
    expect(seen[0]).toContain("タサブロウ");
    expect(seen[0]).toContain("English");
  });
});

describe("buildSystemPrompt", () => {
  it("substitutes the language and marks official names", () => {
    const p = buildSystemPrompt(DEFAULT_SYSTEM_PROMPT, "zh-hant", [
      { jp: "火のテンジン", tl: { "zh-hant": "天神" } },
      { jp: "タサブロウ" },
    ]);
    expect(p).toContain("繁體中文");
    expect(p).not.toContain("{{targetLanguage}}");
    expect(p).toContain("火のテンジン = 天神");
    expect(p).toContain("タサブロウ");
  });
});

/** Stand-in endpoint: echoes each numbered line back with a prefix. */
function echoChat(opts: { dropFirstLine?: boolean; dropFirstLineOnce?: boolean } = {}) {
  let dropped = false;
  return async (req: { system: string; user: string }): Promise<ChatResponse> => {
    const lines = req.user
      .split("\n")
      .map((l) => /^(\d+) (?:>\S+ |# )?(?:[^:：]{1,24}[:：] )?(.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => `${m[1]} [EN] ${m[2]}`);
    const dropNow = opts.dropFirstLine || (opts.dropFirstLineOnce && !dropped);
    if (dropNow) dropped = true;
    const body = dropNow ? lines.slice(1) : lines;
    return {
      content: body.join("\n"),
      finishReason: "stop",
      usage: { promptTokens: req.user.length, completionTokens: body.join("\n").length },
    };
  };
}
