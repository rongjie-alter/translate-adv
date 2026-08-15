import { useCallback, useEffect, useState } from "preact/hooks";
import { LibraryView } from "./LibraryView";
import { ScanView } from "./ScanView";
import { SettingsView } from "./SettingsView";
import { TranslateView } from "./TranslateView";
import { useStore, type View } from "./store";
import { useTranslation } from "./useTranslation";

const TABS: { id: View; label: string }[] = [
  { id: "scan", label: "Scan" },
  { id: "translate", label: "Translate" },
  { id: "library", label: "Library" },
  { id: "settings", label: "Settings" },
];

export function App() {
  const store = useStore();
  const translation = useTranslation();
  const [dragging, setDragging] = useState(false);

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
      if (translation.running && v !== "translate") {
        const ok = confirm("A translation is running. Leave this screen? It will keep running.");
        if (!ok) return;
      }
      store.setView(v);
    },
    [store, translation.running],
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
        {store.view === "scan" && <ScanView translation={translation} />}
        {store.view === "translate" && <TranslateView translation={translation} />}
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
    </div>
  );
}
