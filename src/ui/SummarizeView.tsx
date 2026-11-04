/**
 * Chapter synopses: pick a document (or paste text), pick a model, run.
 *
 * Two modes over one core. Book mode reads a scanned `.book.html`, a Library
 * translation or a dropped `.bilingual.html`, and keeps a synopsis per chapter; text mode
 * summarizes whatever is pasted and keeps nothing.
 */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { findPreset } from "../llm/presets";
import { textHash, type SummaryChapter, type SummaryDoc } from "../summarize/doc";
import { collectDocs, textDoc } from "../summarize/inputs";
import { exportFileName, exportMarkdown, renderMarkdown } from "../summarize/markdown";
import {
  DEFAULT_SUMMARY_PROMPT,
  SUMMARY_LANGS,
  SUMMARY_LANG_LABEL,
  SUMMARY_LENGTHS,
  SUMMARY_LENGTH_LABEL,
  detectLanguage,
  renderSummaryPrompt,
  type SummaryLang,
  type SummaryLength,
} from "../summarize/prompt";
import { useStore } from "./store";
import type { useSummarize } from "./useSummarize";
import { Waiting } from "./Waiting";

const value = (e: Event) => (e.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;

export function SummarizeView({
  summary,
  busy,
}: {
  summary: ReturnType<typeof useSummarize>;
  busy: boolean;
}) {
  const store = useStore();
  const { settings } = store;
  const { input, setInput } = summary;
  const fileInput = useRef<HTMLInputElement>(null);
  const textInput = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);

  const docs = useMemo(
    () =>
      collectDocs({
        sources: store.sources,
        books: store.books,
        artifacts: store.artifacts,
        bilingual: store.bilingualDocs,
      }),
    [store.sources, store.books, store.artifacts, store.bilingualDocs],
  );
  const bookDoc = docs.find((d) => d.id === input.docId) ?? docs[0] ?? null;
  const pasted = useMemo(() => (input.text.trim() ? textDoc(input.text) : null), [input.text]);
  const doc: SummaryDoc | null = input.mode === "book" ? bookDoc : pasted;

  const preset = findPreset(settings.presets, settings.summaryPresetId);
  const detected = useMemo<SummaryLang>(
    () => doc?.language ?? detectLanguage(doc?.chapters.map((c) => c.text).join("\n") ?? ""),
    [doc],
  );
  const lang = input.language === "auto" ? detected : input.language;
  const system = renderSummaryPrompt(settings.summaryPrompt, lang, settings.summaryLength);

  // Read what is stored whenever the document changes.
  const docId = doc?.id ?? null;
  useEffect(() => {
    void summary.load(docId);
    setEditing(null);
  }, [docId]);

  const records = summary.recordsDocId === docId ? summary.records : new Map();
  // Hashing and planning walk the whole text, so they wait for what they depend on
  // rather than rerunning on every keystroke in the prompt box.
  const hashes = useMemo(() => new Map((doc?.chapters ?? []).map((c) => [c.id, textHash(c.text)] as const)), [doc]);
  const statusOf = (c: SummaryChapter): "none" | "done" | "stale" => {
    const r = records.get(c.id);
    return !r ? "none" : r.srcHash === hashes.get(c.id) ? "done" : "stale";
  };
  const pending = doc ? doc.chapters.filter((c) => statusOf(c) !== "done") : [];
  const pendingKey = pending.map((c) => c.id).join("|");
  const pendingIds = useMemo(() => new Set(pending.map((c) => c.id)), [pendingKey]);
  const plan = useMemo(
    () =>
      doc ? summary.estimate({ doc, ids: pendingIds, preset, system, carryOver: settings.summaryCarryOver }) : null,
    [doc, pendingIds, preset, system, settings.summaryCarryOver, settings.chunkInputTokens, settings.calibration],
  );

  const run = (ids: string[]) =>
    doc &&
    void summary.start({ doc, ids, preset, system, carryOver: settings.summaryCarryOver });

  const state = summary.state;
  const done = doc ? doc.chapters.filter((c) => statusOf(c) === "done") : [];
  const withRecord = doc ? doc.chapters.filter((c) => records.has(c.id)) : [];

  return (
    <section class="summarize">
      <div class="row">
        <button class={input.mode === "book" ? "tab active" : "tab"} onClick={() => setInput({ mode: "book" })}>
          Book
        </button>
        <button class={input.mode === "text" ? "tab active" : "tab"} onClick={() => setInput({ mode: "text" })}>
          Free text
        </button>
        <span class="spacer" />
        <label>
          LLM{" "}
          <select
            value={settings.summaryPresetId}
            onChange={(e) => void store.saveSettings({ summaryPresetId: value(e) })}
          >
            {settings.presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {input.mode === "book" ? (
        <div class="row">
          <select
            value={bookDoc?.id ?? ""}
            disabled={!docs.length}
            onChange={(e) => setInput({ docId: value(e) || null })}
          >
            {!docs.length ? <option value="">— nothing to summarize yet —</option> : null}
            {(["book", "library", "bilingual"] as const).map((origin) => {
              const group = docs.filter((d) => d.origin === origin);
              return group.length ? (
                <optgroup key={origin} label={ORIGIN_LABEL[origin]}>
                  {group.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.title}
                    </option>
                  ))}
                </optgroup>
              ) : null;
            })}
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
        </div>
      ) : (
        <div class="sm-text">
          <textarea
            rows={10}
            placeholder="Paste any text to summarize…"
            value={input.text}
            onInput={(e) => setInput({ text: value(e) })}
          />
          <div class="row">
            <button onClick={() => textInput.current?.click()}>Load .txt / .md…</button>
            <input
              ref={textInput}
              type="file"
              accept=".txt,.md,.markdown,text/plain"
              hidden
              onChange={async (e) => {
                const file = (e.target as HTMLInputElement).files?.[0];
                (e.target as HTMLInputElement).value = "";
                if (file) setInput({ text: await file.text() });
              }}
            />
            <span class="hint">{input.text.length.toLocaleString()} characters. Nothing is stored for free text.</span>
          </div>
        </div>
      )}

      {input.mode === "book" && !docs.length ? (
        <p class="empty">
          Drop a <code>.book.html</code> (Japanese or an official translation), a{" "}
          <code>.bilingual.html</code> or a <code>.tl.json</code> anywhere on this page. Translations
          already in the Library appear here by themselves.
        </p>
      ) : null}

      {doc ? (
        <>
          <div class="row">
            <label>
              Length{" "}
              <select
                value={settings.summaryLength}
                onChange={(e) => void store.saveSettings({ summaryLength: value(e) as SummaryLength })}
              >
                {SUMMARY_LENGTHS.map((l) => (
                  <option key={l} value={l}>
                    {SUMMARY_LENGTH_LABEL[l]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Language{" "}
              <select
                value={input.language}
                onChange={(e) => setInput({ language: value(e) as SummaryLang | "auto" })}
              >
                <option value="auto">Auto ({SUMMARY_LANG_LABEL[detected]})</option>
                {SUMMARY_LANGS.map((l) => (
                  <option key={l} value={l}>
                    {SUMMARY_LANG_LABEL[l]}
                  </option>
                ))}
              </select>
            </label>
            {input.mode === "book" ? (
              <label title="Send the previous chapter's synopsis with the next, so names and context stay consistent. Chapters then run one at a time.">
                <input
                  type="checkbox"
                  checked={settings.summaryCarryOver}
                  onChange={(e) => void store.saveSettings({ summaryCarryOver: (e.target as HTMLInputElement).checked })}
                />{" "}
                Carry over the previous chapter
              </label>
            ) : null}
          </div>

          <details class="sm-prompt">
            <summary>Summary prompt</summary>
            <textarea
              rows={14}
              value={settings.summaryPrompt}
              onInput={(e) => void store.saveSettings({ summaryPrompt: value(e) })}
            />
            <div class="row">
              <span class="hint">
                <code>{"{{language}}"}</code> and <code>{"{{length}}"}</code> are filled in per request. Edits
                last for this browser session only.
              </span>
              <span class="spacer" />
              <button onClick={() => void store.saveSettings({ summaryPrompt: DEFAULT_SUMMARY_PROMPT })}>
                Reset to default
              </button>
            </div>
          </details>

          <div class="estimate">
            <div class="row">
              <strong>
                {input.mode === "book"
                  ? `${done.length}/${doc.chapters.length} chapter(s) summarized`
                  : "Summary"}
              </strong>
              <span class="spacer" />
              {summary.running ? (
                <button class="danger" onClick={summary.stop}>
                  Stop
                </button>
              ) : null}
              <button disabled={busy || !pending.length} onClick={() => run(pending.map((c) => c.id))}>
                {input.mode === "text"
                  ? "Summarize"
                  : !pending.length
                    ? "All summarized"
                    : pending.length === doc.chapters.length
                    ? `Summarize all ${pending.length}`
                    : `Summarize ${pending.length} remaining`}
              </button>
              {withRecord.length && input.mode === "book" ? (
                <button
                  onClick={() =>
                    download(
                      exportFileName(doc.title),
                      exportMarkdown(
                        doc.title,
                        withRecord.map((c) => ({
                          // An outdated synopsis is still exported, but marked as such.
                          title: statusOf(c) === "stale" ? `${c.title} (outdated)` : c.title,
                          markdown: records.get(c.id)!.markdown,
                        })),
                      ),
                    )
                  }
                >
                  Download .md
                </button>
              ) : null}
            </div>
            {plan ? (
              <p class="hint">
                {plan.calls} call(s), ~{plan.inputTokens.toLocaleString()} input tokens on {preset.model}
                {plan.longChapters.length
                  ? `. ${plan.longChapters.length} long chapter(s) will be split and merged.`
                  : "."}
                {input.mode === "book" && pending.length > 1
                  ? settings.summaryCarryOver
                    ? " Chapters run one after another."
                    : " Up to 3 chapters run at once."
                  : ""}
              </p>
            ) : null}
          </div>

          {state ? (
            <div class="sm-run">
              <progress value={state.done + state.failed} max={state.total} />
              <div class="counters">
                <span>
                  {state.done}/{state.total} chapters
                </span>
                {state.failed ? <span class="warn">{state.failed} failed</span> : null}
                <span>{state.usage.requests} requests</span>
                <span>
                  {state.usage.promptTokens.toLocaleString()} in / {state.usage.completionTokens.toLocaleString()} out
                </span>
                {!summary.running ? <button onClick={summary.clear}>Clear</button> : null}
              </div>
              <Waiting wait={state.waiting} />
              {state.error ? <p class="warn status-banner error">{state.error}</p> : null}
              {state.finished && !state.error && !state.failed ? (
                <p class="ok status-banner success">Done.</p>
              ) : null}
              <details>
                <summary>Log</summary>
                <ol class="log">
                  {state.log
                    .slice()
                    .reverse()
                    .map((l, i) => (
                      <li key={i} class={l.kind}>
                        <time>{new Date(l.at).toLocaleTimeString()}</time> {l.text}
                      </li>
                    ))}
                </ol>
              </details>
            </div>
          ) : null}

          <div class="sm-chapters">
            {doc.chapters.map((c) => {
              const rec = records.get(c.id);
              const status = statusOf(c);
              const active = !!state && !state.finished && state.active.includes(c.id);
              return (
                <article key={c.id} class={`sm-chapter ${status}`}>
                  <header>
                    <h3>{input.mode === "text" ? "Result" : c.title}</h3>
                    <span class="hint">{c.text.length.toLocaleString()} chars</span>
                    {active ? <span class="dot" /> : null}
                    {status === "stale" ? <span class="sm-badge warn">text changed since</span> : null}
                    {rec?.edited ? <span class="sm-badge">edited</span> : null}
                    <span class="spacer" />
                    {rec ? (
                      <>
                        <button onClick={() => copy(store, rec.markdown)}>Copy</button>
                        <button
                          disabled={editing?.id === c.id}
                          onClick={() => setEditing({ id: c.id, draft: rec.markdown })}
                        >
                          Edit
                        </button>
                      </>
                    ) : null}
                    <button
                      disabled={busy}
                      onClick={() => {
                        if (rec?.edited && !window.confirm("Regenerate and discard your edits to this synopsis?")) return;
                        run([c.id]);
                      }}
                    >
                      {rec ? "Redo" : "Summarize"}
                    </button>
                  </header>
                  {editing?.id === c.id ? (
                    <div class="sm-edit">
                      <textarea
                        rows={10}
                        value={editing.draft}
                        onInput={(e) => setEditing({ id: c.id, draft: value(e) })}
                      />
                      <div class="row">
                        <button
                          onClick={async () => {
                            await summary.edit(doc, c.id, editing.draft);
                            setEditing(null);
                          }}
                        >
                          Save
                        </button>
                        <button onClick={() => setEditing(null)}>Cancel</button>
                      </div>
                    </div>
                  ) : rec ? (
                    <>
                      <div class="sm-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(rec.markdown) }} />
                      <p class="hint">
                        {rec.model} · {new Date(rec.at).toLocaleString()}
                      </p>
                    </>
                  ) : null}
                </article>
              );
            })}
          </div>
        </>
      ) : null}
    </section>
  );
}

const ORIGIN_LABEL = {
  book: "Books (.book.html)",
  library: "Translations in the Library",
  bilingual: "Dropped .bilingual.html files",
} as const;

function copy(store: ReturnType<typeof useStore>, text: string) {
  navigator.clipboard.writeText(text).then(
    () => store.toast("Copied."),
    () => store.toast("Could not copy to the clipboard.", "error"),
  );
}

function download(name: string, contents: string) {
  const blob = new Blob([contents], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
