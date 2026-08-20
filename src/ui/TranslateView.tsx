/**
 * Live progress for the running job, and the list of jobs that can be resumed.
 */
import { LANG_LABEL } from "../scenario/model";
import { jobProgress } from "../orchestrator/job";
import { useActiveBook, useStore } from "./store";
import type { useTranslation } from "./useTranslation";
import { CopyPre } from "./CopyPre";

export function TranslateView({
  translation,
  busy,
}: {
  translation: ReturnType<typeof useTranslation>;
  busy: boolean;
}) {
  const store = useStore();
  const active = useActiveBook();
  const s = translation.state;

  const unfinished = store.jobs.filter((j) => jobProgress(j).done < j.chunks.length);

  return (
    <section class="translate">
      {s ? (
        <>
          <div class="row">
            <h2>
              {s.chapter} → {LANG_LABEL[s.lang]}
            </h2>
            <span class="spacer" />
            {translation.running ? (
              <button class="danger" onClick={translation.stop}>
                Stop
              </button>
            ) : (
              <button onClick={translation.clear}>Clear</button>
            )}
          </div>

          <progress value={s.chunksDone} max={s.chunksTotal} />
          <div class="counters">
            <span>
              {s.chunksDone}/{s.chunksTotal} chunks
            </span>
            <span>
              {s.unitsDone}/{s.unitsTotal} lines
            </span>
            <span>{s.usage.requests} requests</span>
            <span>
              {s.usage.promptTokens.toLocaleString()} in / {s.usage.completionTokens.toLocaleString()} out
            </span>
          </div>

          {s.waiting ? (
            <p class="waiting">
              Waiting {Math.ceil(s.waiting.ms / 1000)}s — {waitReason(s.waiting.reason)}
            </p>
          ) : null}
          {s.error ? <p class="warn status-banner error">{s.error}</p> : null}
          {s.finished && !s.error ? (
            <p class="ok status-banner success">
              Done. Saved to the library.{" "}
              {/* `jobId` is `book::chapter::lang` — the same string as `artifactKey`. */}
              <button class="link" onClick={() => store.openReview(s.jobId)}>
                Review {s.chapter}
              </button>
            </p>
          ) : null}

          <ol class="log">
            {s.log
              .slice()
              .reverse()
              .map((l, i) => (
                <li key={i} class={l.kind}>
                  <time>{new Date(l.at).toLocaleTimeString()}</time> {l.text}
                </li>
              ))}
          </ol>

          {s.calls.length ? (
            <ol class="calls">
              {s.calls
                .slice()
                .reverse()
                .map((c, i) => (
                  <li key={i}>
                    <details>
                      <summary class={c.ok ? "ok" : "warn"}>
                        <time>{new Date(c.at).toLocaleTimeString()}</time> #{c.index + 1} {c.kind} ·{" "}
                        {c.status || "network error"}
                        {c.error ? `: ${c.error}` : ""}
                        {c.usage
                          ? ` · ${c.usage.promptTokens.toLocaleString()} in / ${c.usage.completionTokens.toLocaleString()} out${
                              c.usage.reasoningTokens ? ` (+${c.usage.reasoningTokens.toLocaleString()} thinking)` : ""
                            }`
                          : ""}
                      </summary>
                      <div class="call-body">
                        <h4>System</h4>
                        <CopyPre text={c.system} />
                        <h4>User</h4>
                        <CopyPre text={c.user} />
                        {c.error ? (
                          <>
                            <h4>Error</h4>
                            <CopyPre class="warn" text={c.error} />
                          </>
                        ) : null}
                        {c.response ? (
                          <>
                            <h4>Response</h4>
                            <CopyPre text={c.response} />
                          </>
                        ) : null}
                        {c.reasoning ? (
                          <>
                            <h4>Thinking</h4>
                            <CopyPre text={c.reasoning} />
                          </>
                        ) : null}
                      </div>
                    </details>
                  </li>
                ))}
            </ol>
          ) : null}
        </>
      ) : (
        <p class="empty">Nothing running. Pick a chapter on the Scan screen.</p>
      )}

      {unfinished.length ? (
        <div class="resumable">
          <h3>Unfinished</h3>
          <p class="hint">
            Progress is saved after every chunk, so continuing only pays for what is left.
          </p>
          <ul>
            {unfinished.map((j) => {
              const p = jobProgress(j);
              const source = store.sources.find((src) => src.file === j.bookFile);
              const book = source ? store.books.get(source.id) : undefined;
              return (
                <li key={j.id}>
                  <span>
                    {j.bookFile} · {j.chapter} · {LANG_LABEL[j.lang]} — {p.done}/{p.total} chunks
                    {p.failed ? `, ${p.failed} failed` : ""}
                  </span>
                  <button
                    disabled={busy || !source || !book}
                    title={source ? "" : "Load the original .book.html again to continue"}
                    onClick={() => {
                      const preset =
                        store.settings.presets.find((p) => p.id === j.presetId) ?? store.activePreset();
                      void translation.start(source!, book!, j.chapter, j.lang, preset);
                    }}
                  >
                    Continue
                  </button>
                </li>
              );
            })}
          </ul>
          {!active ? <p class="hint">Load the matching .book.html to continue a job.</p> : null}
        </div>
      ) : null}
    </section>
  );
}

function waitReason(reason: string): string {
  switch (reason) {
    case "rpm":
      return "requests-per-minute limit";
    case "tpm":
      return "tokens-per-minute limit";
    case "rpd":
      return "daily request quota";
    case "backoff":
      return "the endpoint asked us to slow down";
    default:
      return reason;
  }
}
