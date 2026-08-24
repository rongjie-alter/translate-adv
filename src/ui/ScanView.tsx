/**
 * Pick a file, pick a chapter, see what it will cost, start.
 *
 * The estimate is the point of this screen: on a free tier the user needs to know
 * "this chapter is 14 calls and most of today's quota" *before* spending it.
 */
import { useMemo, useRef, useState } from "preact/hooks";
import { estimateJob } from "../llm/estimate";
import { buildSystemPrompt, fileNoteBlock } from "../llm/prompt";
import { serializeChunk } from "../scenario/serialize";
import { makeLabelMap } from "../scenario/labels";
import { LANGS, LANG_LABEL, type Chapter } from "../scenario/model";
import { chapterSpeakers, scanUnknownNames } from "../scenario/parseHtml";
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

          <label class="file-note-label">
            Extra context for this file (known names, character relationships, tone — sent with every
            request)
            <FileNote
              key={active.source.id}
              note={active.source.note ?? ""}
              onSave={(note) => void store.updateSourceNote(active.source.id, note)}
            />
          </label>

          <NameScanner
            key={active.source.id + "|" + lang}
            book={active.book}
            lang={lang}
            saved={active.source.customNames?.[lang] ?? {}}
            onSave={(display, name) =>
              void store.updateCustomName(active.source.id, lang, display, name)
            }
          />

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
      const customNames = active?.source.customNames?.[lang] ?? {};
      const system =
        buildSystemPrompt(store.settings.systemPrompt, lang, chapterSpeakers(c), customNames) +
        fileNoteBlock(active?.source.note ?? "");
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
    }, [c, lang, preset, store.settings, store.artifacts, active?.source.note, active?.source.customNames]);
  }
}

/**
 * Local draft state, keyed by source id via the `key` prop on the caller — so
 * switching files remounts this with the new file's saved note instead of carrying
 * over a stale draft. Persists on blur rather than per keystroke.
 */
function FileNote({ note, onSave }: { note: string; onSave: (note: string) => void }) {
  const [value, setValue] = useState(note);
  return (
    <textarea
      class="file-note"
      rows={2}
      placeholder='e.g. "タサブロウ is teenager."'
      value={value}
      onInput={(e) => setValue((e.target as HTMLTextAreaElement).value)}
      onBlur={() => {
        if (value !== note) onSave(value);
      }}
    />
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return "under a minute";
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/**
 * Name-entry list below the file-note textarea.
 *
 * Keyed by `source.id + lang` so it remounts (and resets draft state) whenever the
 * file or target language changes. Values persist on blur, not per-keystroke, to avoid
 * hammering IndexedDB while the user is typing.
 */
function NameScanner({
  book,
  lang,
  saved,
  onSave,
}: {
  book: import("../scenario/model").Book;
  lang: import("../scenario/model").Lang;
  saved: Record<string, string>;
  onSave: (display: string, name: string) => void;
}) {
  const names = useMemo(() => scanUnknownNames(book, lang), [book, lang]);

  if (!names.length) {
    return (
      <p class="hint name-scanner-empty">
        All character names in this file have an official {LANG_LABEL[lang]} translation.
      </p>
    );
  }

  return (
    <div class="name-scanner">
      <p class="name-scanner-label">
        Unofficial character names — enter translations to include them as official (sent with every
        request and written into exported files):
      </p>
      <div class="name-rows">
        {names.map((n) => (
          <NameRow
            key={n.display}
            display={n.display}
            occurrences={n.occurrences}
            initial={saved[n.display] ?? ""}
            onSave={(v) => onSave(n.display, v)}
          />
        ))}
      </div>
    </div>
  );
}

function NameRow({
  display,
  occurrences,
  initial,
  onSave,
}: {
  display: string;
  occurrences: number;
  initial: string;
  onSave: (v: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div class="name-row">
      <span class="name-jp">
        {display}
        <span class="name-badge">{occurrences}×</span>
      </span>
      <span class="name-eq">=</span>
      <input
        class="name-input"
        type="text"
        value={value}
        placeholder="translated name"
        onInput={(e) => setValue((e.target as HTMLInputElement).value)}
        onBlur={() => {
          if (value !== initial) onSave(value);
        }}
      />
    </div>
  );
}
