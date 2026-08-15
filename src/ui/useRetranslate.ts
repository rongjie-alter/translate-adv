/**
 * Wires the retranslation engine to storage and the Review screen.
 *
 * Deliberately shaped like `useTranslation`: it owns an AbortController, a live
 * log, and the `beforeunload` guard. The difference is that results are *proposed*
 * rather than applied — the user keeps or discards each line before anything is
 * written, because a different model can easily come back worse and there would
 * otherwise be no way back.
 */
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { RateLimiter, emptyState } from "../llm/limiter";
import type { Preset } from "../llm/presets";
import {
  planRetranslate,
  retranslateSystemPrompt,
  runRetranslate,
  type RetranslateEvent,
} from "../orchestrator/retranslate";
import { estimateTokens } from "../llm/estimate";
import { makeLabelMap } from "../scenario/labels";
import type { Lang } from "../scenario/model";
import * as db from "../storage/db";
import {
  applyTranslations,
  artifactKey,
  artifactLabelIds,
  artifactSpeakers,
  type Artifact,
} from "../storage/exchange";
import { useStore } from "./store";
import type { LogLine } from "./useTranslation";

/** One line the model has re-done, awaiting the user's decision. */
export interface Proposal {
  uid: string;
  src: string;
  previous: string;
  next: string;
  keep: boolean;
}

export interface RetryState {
  artifactKey: string;
  chapter: string;
  lang: Lang;
  model: string;
  requestsDone: number;
  requestsTotal: number;
  unitsTotal: number;
  usage: { requests: number; promptTokens: number; completionTokens: number };
  waiting: { ms: number; reason: string } | null;
  log: LogLine[];
  proposals: Proposal[];
  /** Lines that were asked for but never came back. */
  missing: string[];
  finished: boolean;
  error?: string;
}

export interface RetryEstimate {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  contextLines: number;
  unknown: string[];
}

export function useRetranslate() {
  const store = useStore();
  const [state, setState] = useState<RetryState | null>(null);
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

  /** What a retry would cost, for the action bar. Pure — no quota is touched. */
  const estimate = useCallback(
    (artifact: Artifact, uids: string[], preset: Preset, hint?: string): RetryEstimate | null => {
      if (!uids.length) return null;
      const cal = store.calibrationFor(preset.model, artifact.lang, preset);
      const system = retranslateSystemPrompt(
        store.settings.systemPrompt,
        artifact.lang,
        artifactSpeakers(artifact),
        hint,
      );
      const systemTokens = estimateTokens(system, cal.charsPerToken);
      const plan = planRetranslate(
        { artifact, uids },
        {
          labels: makeLabelMap(artifactLabelIds(artifact)),
          lang: artifact.lang,
          systemTokens,
          charsPerToken: cal.charsPerToken,
          outputRatio: cal.outputRatio,
          maxInputTokens: store.settings.chunkInputTokens || preset.limits.maxInputTokens,
          maxOutputTokens: preset.limits.maxOutputTokens,
        },
      );
      return {
        calls: plan.requests.length,
        inputTokens: plan.requests.reduce((n, r) => n + r.inputTokens + systemTokens, 0),
        outputTokens: plan.requests.reduce((n, r) => n + r.outputTokens, 0),
        contextLines: plan.contextUids.length,
        unknown: plan.unknown,
      };
    },
    [store],
  );

  const start = useCallback(
    async (artifact: Artifact, uids: string[], preset: Preset, hint?: string) => {
      if (!uids.length) return;
      const key = artifactKey(artifact);
      const apiKey = store.apiKey(preset);
      if (!apiKey && !preset.baseUrl.includes("localhost")) {
        store.toast(`Add an API key for ${preset.label} in Settings first.`, "error");
        store.setView("settings");
        return;
      }

      const calibration = store.calibrationFor(preset.model, artifact.lang, preset);
      abort.current = new AbortController();
      setState({
        artifactKey: key,
        chapter: artifact.chapter,
        lang: artifact.lang,
        model: preset.model,
        requestsDone: 0,
        requestsTotal: 1,
        unitsTotal: uids.length,
        usage: { requests: 0, promptTokens: 0, completionTokens: 0 },
        waiting: null,
        log: [],
        proposals: [],
        missing: [],
        finished: false,
      });

      // The limiter must be the *chosen* preset's counter, not the active one, or
      // a retry silently spends another endpoint's free-tier quota.
      const limiter = new RateLimiter(
        preset.limits,
        preset.quotaResetTz,
        store.settings.limiter[preset.id] ?? emptyState(),
        (s) => void store.saveSettings({ limiter: { ...store.settings.limiter, [preset.id]: s } }),
      );

      const byId = new Map(artifact.units.map((u) => [u.id, u]));

      try {
        const result = await runRetranslate(
          { artifact, uids },
          {
            limiter,
            apiKey,
            baseUrl: preset.baseUrl,
            model: preset.model,
            maxOutputTokens: preset.limits.maxOutputTokens,
            reasoningEffort: preset.reasoningEffort,
            maxInputTokens: store.settings.chunkInputTokens || preset.limits.maxInputTokens,
            systemPromptTemplate: store.settings.systemPrompt,
            speakers: artifactSpeakers(artifact),
            labels: makeLabelMap(artifactLabelIds(artifact)),
            calibration,
            lang: artifact.lang,
            hint,
            // Nothing is persisted here: the user has not accepted these yet.
            saveUnits: async () => {},
            onCalibration: (c) => {
              void store.saveSettings({
                calibration: {
                  ...store.settings.calibration,
                  [`${preset.model}:${artifact.lang}`]: c,
                },
              });
            },
            onEvent: (e) => onEvent(e, setState),
          },
          abort.current.signal,
        );

        const proposals: Proposal[] = [...result.translations].map(([uid, next]) => ({
          uid,
          src: byId.get(uid)?.src ?? "",
          previous: result.previous.get(uid) ?? "",
          next,
          keep: true,
        }));

        setState((s) =>
          s ? { ...s, finished: true, proposals, missing: result.missing, usage: result.usage } : s,
        );
        if (!proposals.length) {
          store.toast("Nothing came back — the lines were left as they were.", "error");
        }
      } catch (e) {
        const message = abort.current?.signal.aborted
          ? "Stopped. Nothing was changed."
          : (e as Error).message;
        setState((s) => (s ? { ...s, finished: true, error: message } : s));
      }
    },
    [store],
  );

  /** Write the kept lines, and only those. */
  const apply = useCallback(
    async (artifact: Artifact, accepted: Proposal[]) => {
      if (!accepted.length) {
        setState(null);
        return;
      }
      const key = artifactKey(artifact);
      const model = state?.model ?? artifact.model;
      const texts = new Map(accepted.map((p) => [p.uid, p.next]));

      await db.putUnits(key, texts, { keepPrevious: true, model, at: Date.now() });
      await store.saveArtifact(applyTranslations(artifact, texts, { model, at: Date.now() }));

      store.toast(
        `${accepted.length} line${accepted.length === 1 ? "" : "s"} updated — saved to the library.`,
      );
      setState(null);
    },
    [store, state?.model],
  );

  /** Put back what the last accepted retry replaced. */
  const revert = useCallback(
    async (artifact: Artifact, uids: string[]) => {
      const key = artifactKey(artifact);
      const restored = await db.revertUnits(key, uids);
      if (!restored.size) {
        store.toast("Nothing to put back.", "error");
        return;
      }
      await store.saveArtifact(
        applyTranslations(artifact, restored, { model: artifact.model, at: Date.now() }),
      );
      store.toast(`Put back ${restored.size} line${restored.size === 1 ? "" : "s"}.`);
    },
    [store],
  );

  const setProposals = useCallback((fn: (p: Proposal[]) => Proposal[]) => {
    setState((s) => (s ? { ...s, proposals: fn(s.proposals) } : s));
  }, []);

  const stop = useCallback(() => {
    abort.current?.abort(new Error("stopped by user"));
  }, []);

  const clear = useCallback(() => setState(null), []);

  return { state, running, estimate, start, stop, apply, revert, setProposals, clear };
}

function onEvent(
  e: RetranslateEvent,
  setState: (fn: (s: RetryState | null) => RetryState | null) => void,
) {
  setState((s) => {
    if (!s) return s;
    const add = (kind: LogLine["kind"], text: string): RetryState => ({
      ...s,
      log: [...s.log.slice(-200), { at: Date.now(), kind, text }],
    });
    switch (e.type) {
      case "plan":
        return {
          ...add(
            "info",
            `${e.units} line(s) in ${e.requests} call(s) — ~${e.inputTokens.toLocaleString()} in / ~${e.outputTokens.toLocaleString()} out.`,
          ),
          requestsTotal: e.requests,
        };
      case "request-start":
        return { ...add("info", `Call ${e.index + 1}/${e.total} (${e.units} lines)…`), waiting: null };
      case "request-done":
        return {
          ...add("info", `Call ${e.index + 1} done — ${e.usage.prompt} in / ${e.usage.completion} out`),
          requestsDone: s.requestsDone + 1,
          usage: {
            requests: s.usage.requests + 1,
            promptTokens: s.usage.promptTokens + e.usage.prompt,
            completionTokens: s.usage.completionTokens + e.usage.completion,
          },
          waiting: null,
        };
      case "request-failed":
        return add("error", `Call ${e.index + 1} failed: ${e.error}`);
      case "retry":
        return add("warn", `Retry ${e.attempt} for call ${e.index + 1}: ${e.error}`);
      case "repair":
        return add("warn", `Call ${e.index + 1}: re-asking for ${e.missing} missing line(s)`);
      case "waiting":
        return { ...s, waiting: { ms: e.ms, reason: e.reason } };
      case "log":
        return add("info", e.message);
      case "done":
        return add(
          e.failed ? "warn" : "info",
          e.failed ? `Finished with ${e.failed} failed call(s).` : `Finished — ${e.translated} line(s) back.`,
        );
    }
  });
}
