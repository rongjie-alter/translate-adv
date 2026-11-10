/**
 * Wires the summarizer core to storage and the Summarize screen.
 *
 * Shaped like `useTranslation`: it owns an AbortController, a live log and the
 * `beforeunload` guard. Each synopsis is written to IndexedDB as its chapter lands, so
 * a closed tab costs the chapter in flight and nothing else, and a rerun skips what is
 * already there.
 */
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { estimateTokens } from "../llm/estimate";
import { apiKeyMissing, type Preset } from "../llm/presets";
import * as db from "../storage/db";
import type { SummaryRecord } from "../storage/db";
import {
  planSummary,
  summarizeDoc,
  type SummarizeEvent,
  type SummaryPlan,
} from "../summarize/core";
import { summaryKey, textHash, type SummaryChapter, type SummaryDoc } from "../summarize/doc";
import { TEXT_DOC_ID } from "../summarize/inputs";
import type { SummaryLang } from "../summarize/prompt";
import { useStore } from "./store";
import { waitState, type WaitState } from "./Waiting";
import type { LogLine } from "./useTranslation";

export interface SummaryRunState {
  docId: string;
  total: number;
  done: number;
  failed: number;
  /** Chapters being summarized right now — several when carry-over is off. */
  active: string[];
  usage: { requests: number; promptTokens: number; completionTokens: number };
  waiting: WaitState | null;
  log: LogLine[];
  finished: boolean;
  error?: string;
}

export interface StartArgs {
  doc: SummaryDoc;
  /** Chapters to generate. */
  ids: string[];
  preset: Preset;
  /** The rendered system prompt. */
  system: string;
  carryOver: boolean;
}

/**
 * What the screen has been told, kept here rather than in the view: `App` unmounts the
 * view on every tab switch, and a long pasted text must survive a trip to Settings for
 * an API key.
 */
export interface SummarizeInput {
  mode: "book" | "text";
  /** The chosen document; null picks the first on offer. */
  docId: string | null;
  text: string;
  /** `auto` detects the language from the text. */
  language: SummaryLang | "auto";
}

/** Synopses for one document, keyed by chapter id. */
type Records = { docId: string | null; byChapter: Map<string, SummaryRecord> };

export function useSummarize() {
  const store = useStore();
  const [state, setState] = useState<SummaryRunState | null>(null);
  const [records, setRecords] = useState<Records>({ docId: null, byChapter: new Map() });
  const [input, setInput] = useState<SummarizeInput>({ mode: "book", docId: null, text: "", language: "auto" });
  const abort = useRef<AbortController | null>(null);
  const running = !!state && !state.finished;

  useEffect(() => {
    if (!running) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [running]);

  /** Switch the screen to a document: read what is stored for it. Free text has nothing stored. */
  const load = useCallback(async (docId: string | null) => {
    setRecords((cur) => (cur.docId === docId ? cur : { docId, byChapter: new Map() }));
    if (!docId || docId === TEXT_DOC_ID) return;
    const rows = await db.listSummaries(docId);
    setRecords((cur) =>
      // The user may have moved on while the read was in flight.
      cur.docId === docId
        ? { docId, byChapter: new Map([...rows.map((r) => [r.chapterId, r] as const), ...cur.byChapter]) }
        : cur,
    );
  }, []);

  const put = useCallback(async (rec: SummaryRecord, persist: boolean) => {
    if (persist) await db.putSummary(rec);
    setRecords((cur) =>
      cur.docId === rec.docId ? { docId: cur.docId, byChapter: new Map(cur.byChapter).set(rec.chapterId, rec) } : cur,
    );
  }, []);

  /** What a run would cost, for the page. Pure — no quota is touched. */
  const estimate = useCallback(
    (args: Omit<StartArgs, "ids"> & { ids: ReadonlySet<string> }): SummaryPlan | null => {
      if (!args.ids.size) return null;
      const charsPerToken = store.calibrationFor(args.preset.model, "en", args.preset).charsPerToken;
      return planSummary(args.doc, args.ids, {
        systemTokens: estimateTokens(args.system, charsPerToken),
        charsPerToken,
        maxInputTokens: store.settings.chunkInputTokens || args.preset.limits.maxInputTokens,
        carryOver: args.carryOver,
      });
    },
    [store],
  );

  const start = useCallback(
    async ({ doc, ids, preset, system, carryOver }: StartArgs) => {
      if (!ids.length) return;
      const apiKey = store.apiKey(preset);
      if (apiKeyMissing(preset, apiKey)) {
        store.toast(`Add an API key for ${preset.label} in Settings first.`, "error");
        store.setView("settings");
        return;
      }

      const persist = doc.id !== TEXT_DOC_ID;
      abort.current = new AbortController();
      setState({
        docId: doc.id,
        total: ids.length,
        done: 0,
        failed: 0,
        active: [],
        usage: { requests: 0, promptTokens: 0, completionTokens: 0 },
        waiting: null,
        log: [],
        finished: false,
      });

      // The *chosen* preset's counter, not the active one, or a summary run silently
      // spends another endpoint's free-tier quota.
      const limiter = store.limiterFor(preset);

      const byId = new Map(doc.chapters.map((c) => [c.id, c]));
      // Only synopses of the text as it is now may stand in as carry-over; a stale one
      // would feed the next chapter context from a different version of the story.
      const existing = new Map<string, string>();
      if (records.docId === doc.id) {
        for (const c of doc.chapters) {
          const r = records.byChapter.get(c.id);
          if (r && r.srcHash === textHash(c.text)) existing.set(c.id, r.markdown);
        }
      }

      try {
        const result = await summarizeDoc(
          {
            doc,
            ids: new Set(ids),
            existing,
            carryOver,
            system,
            onChapter: async (id, r) => {
              const chapter = byId.get(id) as SummaryChapter;
              await put(
                {
                  key: summaryKey(doc.id, id),
                  docId: doc.id,
                  chapterId: id,
                  title: chapter.title,
                  markdown: r.markdown,
                  model: preset.model,
                  srcHash: textHash(chapter.text),
                  at: Date.now(),
                },
                persist,
              );
            },
          },
          {
            limiter,
            apiKey,
            baseUrl: preset.baseUrl,
            model: preset.model,
            // A synopsis is a few hundred tokens; the preset's cap is sized for translation.
            maxOutputTokens: Math.min(preset.limits.maxOutputTokens, 4096),
            reasoningEffort: preset.reasoningEffort,
            charsPerToken: store.calibrationFor(preset.model, "en", preset).charsPerToken,
            maxInputTokens: store.settings.chunkInputTokens || preset.limits.maxInputTokens,
            onEvent: (e) => onEvent(e, setState),
          },
          abort.current.signal,
        );
        setState((s) => (s ? { ...s, finished: true, done: result.done, failed: result.failed, active: [] } : s));
      } catch (e) {
        const message = abort.current?.signal.aborted
          ? "Stopped. Finished chapters were kept."
          : (e as Error).message;
        setState((s) => (s ? { ...s, finished: true, active: [], error: message } : s));
      }
    },
    [store, records, put],
  );

  /** Replace a synopsis with the user's own words. */
  const edit = useCallback(
    async (doc: SummaryDoc, chapterId: string, markdown: string) => {
      const chapter = doc.chapters.find((c) => c.id === chapterId);
      const old = records.docId === doc.id ? records.byChapter.get(chapterId) : undefined;
      if (!chapter || !old) return;
      await put({ ...old, markdown, edited: true, at: Date.now() }, doc.id !== TEXT_DOC_ID);
    },
    [records, put],
  );

  const stop = useCallback(() => {
    abort.current?.abort(new Error("stopped by user"));
  }, []);

  const clear = useCallback(() => setState(null), []);

  return {
    input,
    setInput: useCallback((patch: Partial<SummarizeInput>) => setInput((cur) => ({ ...cur, ...patch })), []),
    state,
    running,
    records: records.byChapter,
    recordsDocId: records.docId,
    load,
    estimate,
    start,
    edit,
    stop,
    clear,
  };
}

function onEvent(e: SummarizeEvent, setState: (fn: (s: SummaryRunState | null) => SummaryRunState | null) => void) {
  setState((s) => {
    if (!s) return s;
    const add = (kind: LogLine["kind"], text: string): SummaryRunState => ({
      ...s,
      log: [...s.log.slice(-200), { at: Date.now(), kind, text }],
    });
    switch (e.type) {
      case "chapter-start":
        return { ...add("info", `${e.title} (${e.position + 1}/${e.total})…`), active: [...s.active, e.id], waiting: null };
      case "chapter-done":
        return {
          ...add(
            "info",
            `${e.id} done — ${e.usage.promptTokens.toLocaleString()} in / ${e.usage.completionTokens.toLocaleString()} out` +
              (e.parts > 1 ? ` (${e.parts} parts merged)` : ""),
          ),
          done: s.done + 1,
          active: s.active.filter((id) => id !== e.id),
          usage: {
            requests: s.usage.requests,
            promptTokens: s.usage.promptTokens + e.usage.promptTokens,
            completionTokens: s.usage.completionTokens + e.usage.completionTokens,
          },
        };
      case "chapter-failed":
        return {
          ...add("error", `${e.id} failed: ${e.error}`),
          failed: s.failed + 1,
          active: s.active.filter((id) => id !== e.id),
        };
      case "retry":
        return add("warn", `Retry ${e.attempt} in ${Math.ceil(e.waitMs / 1000)}s: ${e.error}`);
      case "waiting":
        return { ...s, waiting: waitState(e) };
      case "log":
        return add("info", e.message);
      case "call":
        // One per HTTP attempt; the counter is requests, not chapters.
        return e.ok ? { ...s, usage: { ...s.usage, requests: s.usage.requests + 1 } } : s;
      case "repair":
        return s;
    }
  });
}
