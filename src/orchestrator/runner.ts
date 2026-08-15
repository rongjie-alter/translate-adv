/**
 * Drives one job to completion: chunk -> wait for quota -> call -> parse -> repair
 * -> persist, and around again.
 *
 * Two rules shape the design. Progress is written after every chunk, so a closed tab
 * or a dead connection costs one chunk, never the chapter. And a request is only
 * ever sent when the limiter says there is quota for it, because on a free tier a
 * throttled request is quota burned for nothing.
 */
import { backoffMs, chat, LlmError, sleep, type ChatResponse } from "../llm/client";
import { calibrate, estimateTokens, type Calibration } from "../llm/estimate";
import type { Quota } from "../llm/limiter";
import { buildSystemPrompt, REPAIR_INSTRUCTION } from "../llm/prompt";
import type { Lang, Speaker } from "../scenario/model";
import { parseResponse, serializeChunk, serializeRepair, type WireLine } from "../scenario/serialize";
import type { LabelMap } from "../scenario/labels";
import type { Chunk } from "./chunker";
import { type Job, type JobChunk } from "./job";

export type RunEvent =
  | { type: "chunk-start"; index: number; total: number; units: number }
  | { type: "chunk-done"; index: number; units: number; usage: { prompt: number; completion: number } }
  | { type: "chunk-failed"; index: number; error: string }
  | { type: "waiting"; ms: number; reason: string }
  | { type: "retry"; index: number; attempt: number; error: string }
  | { type: "repair"; index: number; missing: number }
  | { type: "log"; message: string }
  | { type: "done"; failed: number };

export interface RunnerDeps {
  limiter: Quota;
  apiKey: string;
  baseUrl: string;
  model: string;
  maxOutputTokens: number;
  systemPromptTemplate: string;
  speakers: Speaker[];
  labels: LabelMap;
  calibration: Calibration;
  /** Persist translated units for one chunk. Must resolve before the chunk is marked done. */
  saveUnits(chunk: JobChunk, translations: Map<string, string>): Promise<void>;
  saveJob(job: Job): Promise<void>;
  onCalibration(c: Calibration): void;
  onEvent(e: RunEvent): void;
  /** Injectable for tests. */
  chat?: typeof chat;
}

const MAX_ATTEMPTS = 4;
const MAX_REPAIRS = 2;
/** Translated lines carried into the next chunk so the model keeps its footing. */
const CONTEXT_LINES = 3;

export async function runJob(
  job: Job,
  chunks: Chunk[],
  lang: Lang,
  deps: RunnerDeps,
  signal: AbortSignal,
): Promise<Job> {
  const call = deps.chat ?? chat;
  const system = buildSystemPrompt(deps.systemPromptTemplate, lang, deps.speakers);
  let context: string[] = [];
  let calibration = deps.calibration;

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const record = job.chunks[ci];
    if (record.status === "done") {
      context = []; // resumed run: no in-memory tail, so start the next chunk cold
      continue;
    }

    signal.throwIfAborted();
    deps.onEvent({ type: "chunk-start", index: record.index, total: chunks.length, units: chunk.units });

    const wire = serializeChunk(chunk.nodes, { labels: deps.labels, lang, context });
    const estimate =
      estimateTokens(system, calibration.charsPerToken) +
      estimateTokens(wire.text, calibration.charsPerToken);

    try {
      const { translations, missing, usage } = await translateChunk({
        system,
        wire,
        estimate,
        charsPerToken: calibration.charsPerToken,
        deps,
        call,
        signal,
        record,
      });

      await deps.saveUnits(record, translations);
      record.status = "done";
      record.attempts++;
      if (missing.length) {
        record.missing = missing.map((l) => l.uid);
        (job.warnings ??= []).push(
          `Chunk ${record.index + 1}: ${missing.length} line(s) came back empty and were left untranslated.`,
        );
      }
      job.usage.requests++;
      job.usage.promptTokens += usage.promptTokens;
      job.usage.completionTokens += usage.completionTokens;
      job.updatedAt = Date.now();

      calibration = calibrate(calibration, {
        promptText: system + wire.text,
        promptTokens: usage.promptTokens,
        sourceTokens: chunk.tokens,
        completionTokens: usage.completionTokens,
      });
      deps.onCalibration(calibration);

      context = wire.lines
        .slice(-CONTEXT_LINES)
        .map((l) => translations.get(l.uid) ?? "")
        .filter(Boolean);

      await deps.saveJob(job);
      deps.onEvent({
        type: "chunk-done",
        index: record.index,
        units: translations.size,
        usage: { prompt: usage.promptTokens, completion: usage.completionTokens },
      });
    } catch (e) {
      if (signal.aborted) throw e;
      record.status = "failed";
      record.error = (e as Error).message;
      job.updatedAt = Date.now();
      await deps.saveJob(job);
      deps.onEvent({ type: "chunk-failed", index: record.index, error: record.error });
      // A dead endpoint or an exhausted daily quota will fail every remaining chunk
      // the same way; stopping leaves the quota for a later, working run.
      if (isFatal(e)) break;
    }
  }

  const failed = job.chunks.filter((c) => c.status === "failed").length;
  deps.onEvent({ type: "done", failed });
  return job;
}

function isFatal(e: unknown): boolean {
  return e instanceof LlmError && !e.retryable;
}

async function translateChunk(args: {
  system: string;
  wire: { text: string; lines: WireLine[] };
  estimate: number;
  charsPerToken: number;
  deps: RunnerDeps;
  call: typeof chat;
  signal: AbortSignal;
  record: JobChunk;
}) {
  const { system, wire, estimate, deps, signal, record } = args;

  const first = await send(system, wire.text, estimate, args);
  const parsed = parseResponse(first.content, wire.lines);
  const translations = parsed.translations;
  let missing = parsed.missing;
  const usage = { ...first.usage };

  for (let round = 0; round < MAX_REPAIRS && missing.length; round++) {
    deps.onEvent({ type: "repair", index: record.index, missing: missing.length });
    const repairSystem = `${system}\n\n${REPAIR_INSTRUCTION}`;
    const body = serializeRepair(missing);
    const est = estimateTokens(repairSystem + body, args.charsPerToken);
    const res = await send(repairSystem, body, est, args);
    usage.promptTokens += res.usage.promptTokens;
    usage.completionTokens += res.usage.completionTokens;
    const again = parseResponse(res.content, missing);
    for (const [uid, text] of again.translations) translations.set(uid, text);
    if (again.missing.length === missing.length) break; // making no progress
    missing = again.missing;
  }

  if (first.finishReason === "length") {
    deps.onEvent({
      type: "log",
      message: `Chunk ${record.index + 1} hit the output limit; ${missing.length} line(s) needed repair.`,
    });
  }

  signal.throwIfAborted();
  return { translations, missing, usage };
}

/** One request, with quota waiting and retry/backoff around it. */
async function send(
  system: string,
  user: string,
  estimate: number,
  args: { deps: RunnerDeps; call: typeof chat; signal: AbortSignal; record: JobChunk },
): Promise<ChatResponse> {
  const { deps, call, signal, record } = args;
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    signal.throwIfAborted();

    for (;;) {
      const avail = deps.limiter.check(estimate);
      if (!avail.waitMs) break;
      deps.onEvent({ type: "waiting", ms: avail.waitMs, reason: avail.reason ?? "quota" });
      if (avail.reason === "rpd") {
        throw new LlmError(
          "Daily request quota is used up. The job will resume from here once it resets.",
          429,
          false,
        );
      }
      await sleep(Math.min(avail.waitMs, 15_000), signal);
    }

    deps.limiter.reserve(estimate);
    try {
      const res = await call({
        baseUrl: deps.baseUrl,
        apiKey: deps.apiKey,
        model: deps.model,
        system,
        user,
        maxOutputTokens: deps.maxOutputTokens,
        signal,
      });
      deps.limiter.settle(estimate, res.usage.promptTokens || estimate);
      return res;
    } catch (e) {
      if (signal.aborted) throw e;
      lastError = e;
      if (!(e instanceof LlmError) || !e.retryable) throw e;
      if (e.status === 429) deps.limiter.penalize(e.retryAfter ?? 30);
      const wait = backoffMs(attempt, e.retryAfter);
      deps.onEvent({ type: "retry", index: record.index, attempt: attempt + 1, error: e.message });
      await sleep(wait, signal);
    }
  }
  throw lastError;
}
