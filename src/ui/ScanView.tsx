/**
 * Pick a file, pick a chapter, see what it will cost, start.
 *
 * The estimate is the point of this screen: on a free tier the user needs to know
 * "this chapter is 14 calls and most of today's quota" *before* spending it.
 */
import { useMemo, useRef, useState } from "preact/hooks";
import { estimateJob } from "../llm/estimate";
import { buildSystemPrompt } from "../llm/prompt";
import { serializeChunk } from "../scenario/serialize";
import { makeLabelMap } from "../scenario/labels";
import { LANGS, LANG_LABEL, type Chapter } from "../scenario/model";
import { chapterSpeakers } from "../scenario/parseHtml";
import { jobId, jobProgress } from "../orchestrator/job";
import { artifactKey } from "../storage/exchange";
import { useActiveBook, useStore } from "./store";
import { chunksFor, type useTranslation } from "./useTranslation";

export function ScanView({
  translation,
  busy,
}: {
  translation: ReturnType<typeof useTranslation>;
  busy: boolean;
}) {
  const store = useStore();
  const active = useActiveBook();
  const fileInput = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [presetId, setPresetId] = useState(store.settings.presetId);
  const lang = store.settings.targetLang;
  const preset = store.settings.presets.find((p) => p.id === presetId) ?? store.activePreset();

  const chapter = active?.book.chapters.find((c) => c.name === selected) ?? null;
  const estimate = useEstimate(chapter);

  return (
    <section class="scan">
      <div class="row">
        <select
          value={store.activeSourceId ?? ""}
          onChange={(e) => store.setActiveSource((e.target as HTMLSelectElement).value || null)}
        >
          <option value="">— no file loaded —</option>
          {store.sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.file}
            </option>
          ))}
        </select>
        <button onClick={() => fileInput.current?.click()}>Add file…</button>
        <input
          ref={fileInput}
          type="file"
          accept=".html,.json"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from((e.target as HTMLInputElement).files ?? []);
            if (files.length) void store.addFiles(files);
            (e.target as HTMLInputElement).value = "";
          }}
        />
        {active ? (
          <button class="danger" onClick={() => void store.removeSource(active.source.id)}>
            Remove
          </button>
        ) : null}

        <span class="spacer" />

        <label>
          LLM{" "}
          <select value={presetId} onChange={(e) => setPresetId((e.target as HTMLSelectElement).value)}>
            {store.settings.presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          Target language{" "}
          <select
            value={lang}
            onChange={(e) =>
              void store.saveSettings({
                targetLang: (e.target as HTMLSelectElement).value as (typeof LANGS)[number],
              })
            }
          >
            {LANGS.map((l) => (
              <option key={l} value={l}>
                {LANG_LABEL[l]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!active ? (
        <p class="empty">
          Drop a <code>.book.html</code> produced by <code>parse.py</code> anywhere on this page.
          You can drop <code>.tl.json</code> files from other people here too.
        </p>
      ) : (
        <>
          {!active.book.hasMeta ? (
            <p class="hint">
              This file was made without <code>--tl_meta</code>, so official character names are not
              available. Regenerate it with <code>py parse.py --lang jp {"<book>"}.book.json</code>{" "}
              for better name consistency.
            </p>
          ) : null}

          <table class="chapters">
            <thead>
              <tr>
                <th />
                <th>Chapter</th>
                <th class="num">Lines</th>
                <th class="num">JP chars</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {active.book.chapters.map((c) => {
                const status = chapterStatus(c);
                return (
                  <tr
                    key={c.name}
                    class={selected === c.name ? "sel" : ""}
                    onClick={() => setSelected(c.name)}
                  >
                    <td>
                      <input type="radio" checked={selected === c.name} readOnly />
                    </td>
                    <td>{c.name}</td>
                    <td class="num">{c.units}</td>
                    <td class="num">{c.chars.toLocaleString()}</td>
                    <td class={`status ${status.kind}`}>{status.text}</td>
                    <td class="actions">
                      {status.kind !== "none" ? (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            store.openReview(
                              artifactKey({ book: active.source.file, chapter: c.name, lang }),
                            );
                          }}
                        >
                          Review
                        </button>
                      ) : null}
                      <button
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (status.kind === "done") {
                            if (
                              !window.confirm(
                                `Redo "${c.name}"? This discards the current translation and re-translates from scratch.`,
                              )
                            ) {
                              return;
                            }
                            setSelected(c.name);
                            store.setView("translate");
                            void translation.start(active.source, active.book, c.name, lang, preset, { redo: true });
                            return;
                          }
                          setSelected(c.name);
                          store.setView("translate");
                          void translation.start(active.source, active.book, c.name, lang, preset);
                        }}
                      >
                        {status.kind === "partial" ? "Continue" : status.kind === "done" ? "Redo" : "Translate"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {chapter && estimate ? (
            <div class="estimate">
              <h3>Before you start — {chapter.name} → {LANG_LABEL[lang]}</h3>
              <dl>
                <div>
                  <dt>API calls</dt>
                  <dd>{estimate.calls}</dd>
                </div>
                <div>
                  <dt>Input tokens</dt>
                  <dd>~{estimate.inputTokens.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Output tokens</dt>
                  <dd>~{estimate.outputTokens.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>At best</dt>
                  <dd>{formatDuration(estimate.minSeconds)}</dd>
                </div>
                <div>
                  <dt>Model</dt>
                  <dd>{preset.model}</dd>
                </div>
              </dl>
              <p class="hint">
                {estimate.samples > 0
                  ? `Calibrated against ${estimate.samples} real response(s) from this model.`
                  : "Rough estimate — it self-corrects after the first call, since Japanese tokenizes far denser than English."}
              </p>
              {estimate.exceedsDaily ? (
                <p class="warn">
                  This exceeds the remaining daily request quota ({preset.limits.rpd}/day).
                  It will translate as far as it can and resume after the quota resets.
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </section>
  );

  function chapterStatus(c: Chapter): { kind: string; text: string } {
    const key = artifactKey({ book: active!.source.file, chapter: c.name, lang });
    const artifact = store.artifacts.find((a) => artifactKey(a) === key);
    if (artifact && !artifact.incomplete?.length) return { kind: "done", text: "Translated" };
    const job = store.jobs.find((j) => j.id === jobId(active!.source.file, c.name, lang));
    if (job) {
      const p = jobProgress(job);
      if (p.done < p.total) return { kind: "partial", text: `${p.done}/${p.total} chunks` };
    }
    if (artifact) return { kind: "partial", text: `${artifact.incomplete!.length} lines missing` };
    return { kind: "none", text: "—" };
  }

  function useEstimate(c: Chapter | null) {
    return useMemo(() => {
      if (!c) return null;
      const cal = store.calibrationFor(preset.model, lang);
      const system = buildSystemPrompt(store.settings.systemPrompt, lang, chapterSpeakers(c));
      const chunks = chunksFor(c, {
        maxInputTokens: store.settings.chunkInputTokens || preset.limits.maxInputTokens,
        maxOutputTokens: preset.limits.maxOutputTokens,
        charsPerToken: cal.charsPerToken,
        outputRatio: cal.outputRatio,
        systemPrompt: system,
      });
      const labels = makeLabelMap(
        c.nodes.flatMap((n) => (n.kind === "label" ? [n.id] : n.kind === "jump" ? [n.to] : [])),
      );
      const used = store.settings.limiter[preset.id]?.dayRequests ?? 0;
      return {
        ...estimateJob({
          chunkTexts: chunks.map((ch) => serializeChunk(ch.nodes, { labels, lang }).text),
          systemPrompt: system,
          charsPerToken: cal.charsPerToken,
          outputRatio: cal.outputRatio,
          rpm: preset.limits.rpm,
          rpd: preset.limits.rpd,
          requestsUsedToday: used,
        }),
        samples: cal.samples,
      };
    }, [c, lang, preset, store.settings, store.artifacts]);
  }
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return "under a minute";
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
