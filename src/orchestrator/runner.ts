/**
 * Drives one job to completion: chunk -> wait for quota -> call -> parse -> repair
 * -> persist, and around again.
 *
 * Two rules shape the design. Progress is written after every chunk, so a closed tab
 * or a dead connection costs one chunk, never the chapter. And a request is only
 * ever sent when the limiter says there is quota for it, because on a free tier a
 * throttled request is quota burned for nothing.
 */
import type { chat } from "../llm/client";
import { calibrate, estimateTokens, type Calibration } from "../llm/estimate";
import type { Quota } from "../llm/limiter";
import { buildSystemPrompt, fileNoteBlock } from "../llm/prompt";
import type { Lang, Speaker } from "../scenario/model";
import { serializeChunk } from "../scenario/serialize";
import type { LabelMap } from "../scenario/labels";
import type { Chunk } from "./chunker";
import { isFatal, translateWire, type CallEvent } from "./send";
import { type Job, type JobChunk } from "./job";

export type RunEvent =
  | { type: "chunk-start"; index: number; total: number; units: number }
  | { type: "chunk-done"; index: number; units: number; usage: { prompt: number; completion: number } }
  | { type: "chunk-failed"; index: number; error: string }
  | { type: "waiting"; ms: number; reason: string }
  | { type: "retry"; index: number; attempt: number; error: string }
  | { type: "repair"; index: number; missing: number }
  | { type: "log"; message: string }
  | { type: "done"; failed: number }
  | CallEvent;

export interface RunnerDeps {
  limiter: Quota;
  apiKey: string;
  baseUrl: string;
  model: string;
  maxOutputTokens: number;
  /** Caps "thinking" tokens on reasoning models. `none`/`low`/`medium`/`high`. */
  reasoningEffort?: string;
  systemPromptTemplate: string;
  /** Per-file free-text note (glossary, character context) configured on the Scan tab. */
  fileNote?: string;
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

/** Translated lines carried into the next chunk so the model keeps its footing. */
export const CONTEXT_LINES = 3;

export async function runJob(
  job: Job,
  chunks: Chunk[],
  lang: Lang,
  deps: RunnerDeps,
  signal: AbortSignal,
): Promise<Job> {
  const system =
    buildSystemPrompt(deps.systemPromptTemplate, lang, deps.speakers) + fileNoteBlock(deps.fileNote ?? "");
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
      const { translations, missing, usage } = await translateWire({
        system,
        wire,
        estimate,
        charsPerToken: calibration.charsPerToken,
        index: record.index,
        label: "Chunk",
        deps,
        signal,
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
        totalTokens: usage.totalTokens,
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
