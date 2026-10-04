/**
 * Pick a file, pick a chapter, see what it will cost, start.
 *
 * The estimate is the point of this screen: on a free tier the user needs to know
 * "this chapter is 14 calls and most of today's quota" *before* spending it.
 */
import { useMemo, useRef, useState } from "preact/hooks";
import { estimateJob, estimateTokens } from "../llm/estimate";
import { assembleSystemPrompt, glossaryBlock } from "../llm/prompt";
import { serializeChunk } from "../scenario/serialize";
import { makeLabelMap } from "../scenario/labels";
import { LANGS, LANG_LABEL, type Chapter, type GlossaryEntry } from "../scenario/model";
import { chapterGlossary } from "../scenario/glossary";
import { scanUnknownNames } from "../scenario/parseHtml";
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
  const glossary = useGlossary(chapter);
  const estimate = useEstimate(chapter, glossary);

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
            saved={{
              ...(store.settings.dictionary?.[lang] ?? {}),
              ...(active.source.customNames?.[lang] ?? {}),
            }}
            onSave={(display, name) => {
              void store.updateDictionaryName(lang, display, name);
              void store.updateCustomName(active.source.id, lang, display, name);
            }}
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

          {chapter ? (
            <GlossaryPanel
              key={active.source.id + "|" + chapter.name + "|" + lang}
              chapter={chapter.name}
              glossary={glossary}
              charsPerToken={store.calibrationFor(preset.model, lang).charsPerToken}
              hasTerms={!!active.book.terms}
              excluded={active.source.excludedTerms ?? []}
              onExclude={(jp, off) => void store.setTermExcluded(active.source.id, jp, off)}
              onAdd={(jp, tl) => {
                void store.updateDictionaryName(lang, jp, tl);
                void store.updateCustomName(active.source.id, lang, jp, tl);
              }}
            />
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

  /** What `translation.start` will send as the glossary for this chapter. */
  function useGlossary(c: Chapter | null): GlossaryEntry[] {
    return useMemo(() => {
      if (!c || !active) return [];
      return chapterGlossary(active.book, c, lang, {
        dictionary: store.settings.dictionary?.[lang],
        customNames: active.source.customNames?.[lang],
        excluded: active.source.excludedTerms,
      });
    }, [c, lang, active?.book, active?.source.customNames, active?.source.excludedTerms, store.settings.dictionary]);
  }

  function useEstimate(c: Chapter | null, glossary: GlossaryEntry[]) {
    return useMemo(() => {
      if (!c) return null;
      const cal = store.calibrationFor(preset.model, lang);
      const system = assembleSystemPrompt({
        template: store.settings.systemPrompt,
        lang,
        glossary,
        fileNote: active?.source.note,
      });
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
    }, [c, lang, preset, store.settings, store.artifacts, active?.source.note, glossary]);
  }
}

const SOURCE_LABEL: Record<GlossaryEntry["source"], string> = {
  speaker: "speaker",
  official: "official",
  custom: "yours",
};

/**
 * The names and terms that will be sent with this chapter, so the user can see what
 * the prompt costs and switch off a bad match. Also the quickest way to add a term:
 * it lands in the Dictionary and is sent wherever the Japanese appears.
 */
function GlossaryPanel({
  chapter,
  glossary,
  charsPerToken,
  hasTerms,
  excluded,
  onExclude,
  onAdd,
}: {
  chapter: string;
  glossary: GlossaryEntry[];
  charsPerToken: number;
  hasTerms: boolean;
  excluded: string[];
  onExclude: (jp: string, off: boolean) => void;
  onAdd: (jp: string, tl: string) => void;
}) {
  const [jp, setJp] = useState("");
  const [tl, setTl] = useState("");
  const tokens = estimateTokens(glossaryBlock(glossary), charsPerToken);
  return (
    <details class="glossary-panel" open>
      <summary>
        Glossary for {chapter} — {glossary.length} term{glossary.length === 1 ? "" : "s"}, ~{tokens} tokens
        per request
      </summary>
      <p class="hint">
        Names that speak in this chapter or are mentioned in its text, plus your Dictionary entries that
        appear in it. Uncheck a term to stop sending it for this file.
        {hasTerms ? null : (
          <>
            {" "}
            This file has no <code>#term-meta</code>, so official names of characters who never speak
            are missing — regenerate it with the current <code>parse.py</code> to include them.
          </>
        )}
      </p>
      <ul class="glossary-list">
        {glossary.map((g) => (
          <li key={g.jp}>
            <label>
              <input type="checkbox" checked onChange={() => onExclude(g.jp, true)} />
              <span class="jp">{g.jp}</span> = <span class="tl">{g.tl}</span>
            </label>
            <span class="name-badge">
              {SOURCE_LABEL[g.source]} · {g.count}×
            </span>
          </li>
        ))}
        {excluded.map((e) => (
          <li key={e} class="off">
            <label>
              <input type="checkbox" checked={false} onChange={() => onExclude(e, false)} />
              <span class="jp">{e}</span> <em>(off)</em>
            </label>
          </li>
        ))}
      </ul>
      <form
        class="glossary-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (!jp.trim() || !tl.trim()) return;
          onAdd(jp.trim(), tl.trim());
          setJp("");
          setTl("");
        }}
      >
        <input
          type="text"
          placeholder="日本語 (e.g. パラレルフライト)"
          value={jp}
          onInput={(e) => setJp((e.target as HTMLInputElement).value)}
        />
        <span class="name-eq">=</span>
        <input
          type="text"
          placeholder="translation"
          value={tl}
          onInput={(e) => setTl((e.target as HTMLInputElement).value)}
        />
        <button type="submit" disabled={!jp.trim() || !tl.trim()}>
          Add term
        </button>
      </form>
    </details>
  );
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
