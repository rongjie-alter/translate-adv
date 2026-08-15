import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { LibraryView } from "./LibraryView";
import { ReviewView } from "./ReviewView";
import { ScanView } from "./ScanView";
import { SettingsView } from "./SettingsView";
import { TranslateView } from "./TranslateView";
import { useStore, type View } from "./store";
import { useRetranslate } from "./useRetranslate";
import { useTranslation } from "./useTranslation";

const TABS: { id: View; label: string }[] = [
  { id: "scan", label: "Scan" },
  { id: "translate", label: "Translate" },
  { id: "review", label: "Review" },
  { id: "library", label: "Library" },
  { id: "settings", label: "Settings" },
];

export function App() {
  const store = useStore();
  const translation = useTranslation();
  const retry = useRetranslate();
  // One endpoint, one quota: a retry and a full run must never be in flight together.
  const busy = translation.running || retry.running;
  const [dragging, setDragging] = useState(false);
  const metaWarningRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = metaWarningRef.current;
    if (!dialog) return;
    if (store.metaWarningFiles.length) dialog.showModal();
    else dialog.close();
  }, [store.metaWarningFiles]);

  // One drop target for the whole window: source books and translation files alike.
  useEffect(() => {
    const over = (e: DragEvent) => {
      e.preventDefault();
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) void store.addFiles(files);
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [store]);

  const go = useCallback(
    (v: View) => {
      const home = translation.running ? "translate" : "review";
      if (busy && v !== home) {
        const ok = confirm("A translation is running. Leave this screen? It will keep running.");
        if (!ok) return;
      }
      store.setView(v);
    },
    [store, translation.running, busy],
  );

  if (!store.ready) return <div class="loading">Loading…</div>;

  return (
    <div class={`app${dragging ? " dragging" : ""}`}>
      <header>
        <h1>translate-adv</h1>
        <nav>
          {TABS.map((t) => (
            <button
              key={t.id}
              class={store.view === t.id ? "tab active" : "tab"}
              onClick={() => go(t.id)}
            >
              {t.label}
              {t.id === "translate" && translation.running ? <span class="dot" /> : null}
              {t.id === "review" && retry.running ? <span class="dot" /> : null}
            </button>
          ))}
        </nav>
      </header>

      {translation.running && store.view !== "translate" ? (
        <div class="banner">
          Translating {translation.state?.chapter} — don't close this tab.{" "}
          <button class="link" onClick={() => store.setView("translate")}>
            Show progress
          </button>
        </div>
      ) : null}

      <main>
        {store.view === "scan" && <ScanView translation={translation} busy={busy} />}
        {store.view === "translate" && <TranslateView translation={translation} busy={busy} />}
        {store.view === "review" && <ReviewView retry={retry} busy={busy} />}
        {store.view === "library" && <LibraryView />}
        {store.view === "settings" && <SettingsView />}
      </main>

      {store.conflicts.length ? (
        <div class="conflicts">
          <strong>Merged duplicate translations</strong>
          <ul>
            {store.conflicts.map((c) => (
              <li key={c.key}>
                {c.chapter} ({c.lang}): kept the {c.kept.generatedAt >= c.dropped.generatedAt ? "newer" : "more complete"}{" "}
                one from {c.kept.model || "unknown model"}.
                {c.differentSource ? " Warning: the two were made from different versions of the book." : ""}
              </li>
            ))}
          </ul>
          <button onClick={store.dismissConflicts}>Dismiss</button>
        </div>
      ) : null}

      <div class="toasts">
        {store.toasts.map((t) => (
          <div key={t.id} class={`toast ${t.kind}`}>
            {t.message}
          </div>
        ))}
      </div>

      {dragging ? <div class="dropzone">Drop .book.html or .tl.json files</div> : null}

      <dialog
        class="meta-warning"
        ref={metaWarningRef}
        onClose={store.dismissMetaWarning}
        onCancel={store.dismissMetaWarning}
      >
        <strong>Generated without consolidated character data</strong>
        <p>
          {store.metaWarningFiles.length === 1
            ? store.metaWarningFiles[0]
            : `${store.metaWarningFiles.length} file(s)`}{" "}
          {store.metaWarningFiles.length === 1 ? "was" : "were"} generated before{" "}
          <code>parse.py</code> started embedding the consolidated character-name dictionary.
          Translation consistency may be lower. Regenerate with the latest <code>parse.py</code>{" "}
          for best results.
        </p>
        {store.metaWarningFiles.length > 1 ? (
          <ul>
            {store.metaWarningFiles.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        ) : null}
        <button onClick={() => metaWarningRef.current?.close()}>Continue anyway</button>
      </dialog>
    </div>
  );
}
