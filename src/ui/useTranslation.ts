/**
 * Wires the orchestrator to storage and to the UI.
 *
 * Owns the AbortController for the running job, the live log, and the guard that
 * makes closing the tab mid-translation require a confirmation.
 */
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { estimateTokens } from "../llm/estimate";
import { RateLimiter, emptyState } from "../llm/limiter";
import { buildSystemPrompt } from "../llm/prompt";
import { chunkNodes, type Chunk } from "../orchestrator/chunker";
import { isComplete, jobId, type Job, type JobChunk } from "../orchestrator/job";
import { runJob, type RunEvent } from "../orchestrator/runner";
import { makeLabelMap } from "../scenario/labels";
import { isTranslatable, type Book, type Chapter, type Lang } from "../scenario/model";
import { chapterSpeakers } from "../scenario/parseHtml";
import * as db from "../storage/db";
import type { SourceRecord } from "../storage/db";
import { buildArtifact } from "../storage/exchange";
import { useStore } from "./store";

export interface LogLine {
  at: number;
  kind: "info" | "warn" | "error";
  text: string;
}

export interface RunState {
  jobId: string;
  chapter: string;
  lang: Lang;
  chunksDone: number;
  chunksTotal: number;
  unitsDone: number;
  unitsTotal: number;
  usage: { requests: number; promptTokens: number; completionTokens: number };
  waiting: { ms: number; reason: string } | null;
  log: LogLine[];
  finished: boolean;
  error?: string;
}

export function chunksFor(chapter: Chapter, opts: {
  maxInputTokens: number;
  maxOutputTokens: number;
  charsPerToken: number;
  outputRatio: number;
  systemPrompt: string;
}): Chunk[] {
  return chunkNodes(chapter.nodes, {
    maxInputTokens: opts.maxInputTokens,
    maxOutputTokens: opts.maxOutputTokens,
    charsPerToken: opts.charsPerToken,
    outputRatio: opts.outputRatio,
    systemTokens: estimateTokens(opts.systemPrompt, opts.charsPerToken),
  });
}

export function useTranslation() {
  const store = useStore();
  const [state, setState] = useState<RunState | null>(null);
  const abort = useRef<AbortController | null>(null);
  const running = !!state && !state.finished;

  // Closing the tab loses at most the chunk in flight, but that is still a wasted
  // request against a daily quota — so make it deliberate.
  useEffect(() => {
    if (!running) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [running]);

  const log = useCallback((text: string, kind: LogLine["kind"] = "info") => {
    setState((s) => (s ? { ...s, log: [...s.log.slice(-200), { at: Date.now(), kind, text }] } : s));
  }, []);

  const start = useCallback(
    async (
      source: SourceRecord,
      book: Book,
      chapterName: string,
      lang: Lang,
      opts?: { redo?: boolean },
    ) => {
      const chapter = book.chapters.find((c) => c.name === chapterName);
      if (!chapter) return;

      const preset = store.activePreset();
      const apiKey = store.apiKey();
      if (!apiKey && !preset.baseUrl.includes("localhost")) {
        store.toast("Add an API key for this endpoint in Settings first.", "error");
        store.setView("settings");
        return;
      }

      const calibration = store.calibrationFor(preset.model, lang);
      const speakers = chapterSpeakers(chapter);
      const system = buildSystemPrompt(store.settings.systemPrompt, lang, speakers);
      const maxInputTokens = store.settings.chunkInputTokens || preset.limits.maxInputTokens;
      const chunks = chunksFor(chapter, {
        maxInputTokens,
        maxOutputTokens: preset.limits.maxOutputTokens,
        charsPerToken: calibration.charsPerToken,
        outputRatio: calibration.outputRatio,
        systemPrompt: system,
      });

      const id = jobId(source.file, chapter.name, lang);
      if (opts?.redo) await db.deleteJob(id);
      const previous = await db.getJob(id);
      const done = await db.getUnits(id);
      const job = reconcileJob(id, source, chapter.name, lang, preset.id, preset.model, chunks, previous, done);
      await db.putJob(job);

      const unitsTotal = chapter.nodes.filter(isTranslatable).length;
      const already = job.chunks.filter((c) => c.status === "done").length;
      abort.current = new AbortController();
      setState({
        jobId: id,
        chapter: chapter.name,
        lang,
        chunksDone: already,
        chunksTotal: chunks.length,
        unitsDone: done.size,
        unitsTotal,
        usage: { ...job.usage },
        waiting: null,
        log: [],
        finished: false,
      });
      if (already) log(`Resuming: ${already} of ${chunks.length} chunks already translated.`);

      const limiter = new RateLimiter(
        preset.limits,
        preset.quotaResetTz,
        store.settings.limiter[preset.id] ?? emptyState(),
        (s) => void store.saveSettings({ limiter: { ...store.settings.limiter, [preset.id]: s } }),
      );

      try {
        const finished = await runJob(
          job,
          chunks,
          lang,
          {
            limiter,
            apiKey,
            baseUrl: preset.baseUrl,
            model: preset.model,
            maxOutputTokens: preset.limits.maxOutputTokens,
            reasoningEffort: preset.reasoningEffort,
            systemPromptTemplate: store.settings.systemPrompt,
            speakers,
            labels: makeLabelMap(
              chapter.nodes.flatMap((n) =>
                n.kind === "label" ? [n.id] : n.kind === "jump" ? [n.to] : [],
              ),
            ),
            calibration,
            saveUnits: async (chunk, translations) => {
              await db.putUnits(id, translations);
              setState((s) =>
                s ? { ...s, unitsDone: s.unitsDone + translations.size } : s,
              );
              void chunk;
            },
            saveJob: async (j) => {
              await db.putJob(j);
            },
            onCalibration: (c) => {
              void store.saveSettings({
                calibration: { ...store.settings.calibration, [`${preset.model}:${lang}`]: c },
              });
            },
            onEvent: (e) => onEvent(e, setState),
          },
          abort.current.signal,
        );

        await store.refreshJobs();
        const translations = await db.getUnits(id);
        await store.saveArtifact(
          buildArtifact({
            book: source.file,
            srcHash: source.srcHash,
            chapter,
            lang,
            model: preset.model,
            translations,
            generatedAt: Date.now(),
          }),
        );

        setState((s) => (s ? { ...s, finished: true } : s));
        if (isComplete(finished)) {
          store.toast(`${chapter.name} finished — saved to the library.`);
        } else {
          store.toast(`${chapter.name} stopped with chunks left. Progress is saved; press Continue.`, "error");
        }
      } catch (e) {
        const message = abort.current?.signal.aborted ? "Stopped. Progress is saved." : (e as Error).message;
        setState((s) => (s ? { ...s, finished: true, error: message } : s));
        await store.refreshJobs();
      }
    },
    [store, log],
  );

  const stop = useCallback(() => {
    abort.current?.abort(new Error("stopped by user"));
  }, []);

  const clear = useCallback(() => setState(null), []);

  return { state, running, start, stop, clear };
}

function onEvent(e: RunEvent, setState: (fn: (s: RunState | null) => RunState | null) => void) {
  setState((s) => {
    if (!s) return s;
    const add = (kind: LogLine["kind"], text: string): RunState => ({
      ...s,
      log: [...s.log.slice(-200), { at: Date.now(), kind, text }],
    });
    switch (e.type) {
      case "chunk-start":
        return { ...add("info", `Chunk ${e.index + 1}/${e.total} (${e.units} lines)…`), waiting: null };
      case "chunk-done":
        return {
          ...add("info", `Chunk ${e.index + 1} done — ${e.usage.prompt} in / ${e.usage.completion} out`),
          chunksDone: s.chunksDone + 1,
          usage: {
            requests: s.usage.requests + 1,
            promptTokens: s.usage.promptTokens + e.usage.prompt,
            completionTokens: s.usage.completionTokens + e.usage.completion,
          },
          waiting: null,
        };
      case "chunk-failed":
        return add("error", `Chunk ${e.index + 1} failed: ${e.error}`);
      case "retry":
        return add("warn", `Retry ${e.attempt} for chunk ${e.index + 1}: ${e.error}`);
      case "repair":
        return add("warn", `Chunk ${e.index + 1}: re-asking for ${e.missing} missing line(s)`);
      case "waiting":
        return { ...s, waiting: { ms: e.ms, reason: e.reason } };
      case "log":
        return add("info", e.message);
      case "done":
        return add(e.failed ? "warn" : "info", e.failed ? `Finished with ${e.failed} failed chunk(s).` : "Finished.");
    }
  });
}

/**
 * Match a fresh chunking against previous progress.
 *
 * Chunk boundaries move when the model, the prompt or the size setting changes, so
 * "chunk 3 was done" cannot be carried over blindly. Instead a chunk counts as done
 * when every unit in it already has a stored translation — which is the thing we
 * actually care about not paying for twice.
 */
export function reconcileJob(
  id: string,
  source: { file: string; srcHash: string },
  chapter: string,
  lang: Lang,
  presetId: string,
  model: string,
  chunks: Chunk[],
  previous: Job | undefined,
  translated: Map<string, string>,
): Job {
  const jobChunks: JobChunk[] = chunks.map((c, index) => {
    const uids = c.nodes.filter(isTranslatable).map((n) => n.uid);
    const complete = uids.length > 0 && uids.every((u) => translated.get(u));
    return { index, uids, status: complete ? "done" : "pending", attempts: 0 };
  });

  return {
    id,
    bookFile: source.file,
    srcHash: source.srcHash,
    chapter,
    lang,
    presetId,
    model,
    chunks: jobChunks,
    usage: previous?.usage ?? { requests: 0, promptTokens: 0, completionTokens: 0 },
    createdAt: previous?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  };
}
