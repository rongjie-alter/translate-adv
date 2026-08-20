/**
 * Everything translated so far: export it, share it, merge other people's, and
 * combine it into one readable bilingual file.
 */
import { useMemo, useRef, useState } from "preact/hooks";
import { combineBilingual, combinedFileName } from "../combine/bilingual";
import { LANG_LABEL } from "../scenario/model";
import {
  artifactFileName,
  artifactKey,
  serializeArtifact,
} from "../storage/exchange";
import * as fsa from "../storage/fsa";
import { scanBookGroups, normalizeBookBase, type BookGroup } from "../storage/groups";
import { useStore } from "./store";

export function LibraryView() {
  const store = useStore();
  const folderIntroRef = useRef<HTMLDialogElement>(null);
  const freeRef = useRef<HTMLDialogElement>(null);
  const [freeTarget, setFreeTarget] = useState<BookGroup | null>(null);

  const groups = useMemo<BookGroup[]>(() => {
    return scanBookGroups(store.folderFiles, store.artifacts, store.sources);
  }, [store.folderFiles, store.artifacts, store.sources]);

  return (
    <section class="library">
      <div class="row">
        <h2>Library</h2>
        <span class="spacer" />
        {fsa.isSupported() ? (
          store.folderName ? (
            <>
              <span class="folder">Folder: {store.folderName}</span>
              <button onClick={() => void store.refreshFolderFiles()}>Refresh</button>
              <button onClick={() => void store.syncFolder()}>Import from folder</button>
              <button onClick={() => void store.disconnectFolder()}>Disconnect</button>
            </>
          ) : (
            <button onClick={() => folderIntroRef.current?.showModal()}>Connect a local folder…</button>
          )
        ) : (
          <span class="hint">Folder access needs Chrome or Edge; export/import works everywhere.</span>
        )}
      </div>

      <dialog class="folder-intro" ref={folderIntroRef}>
        <strong>Connect a local folder</strong>
        <p>
          Finished chapters are written there automatically as <code>.tl.json</code>, so a group
          sharing a synced folder gets everyone's translations merged for free instead of mailing
          files around.
        </p>
        <p class="hint">
          The app writes into this folder on its own — pick one that's empty or dedicated to this
          app, not a folder with other important documents.
        </p>
        <div class="row">
          <button onClick={() => folderIntroRef.current?.close()}>Cancel</button>
          <button
            onClick={() => {
              folderIntroRef.current?.close();
              void store.connectFolder();
            }}
          >
            Continue
          </button>
        </div>
      </dialog>

      <dialog class="folder-intro" ref={freeRef}>
        <strong>Free from browser database</strong>
        {freeTarget ? (
          <>
            <p>
              {store.folderName ? (
                <>
                  Make sure <strong>{freeTarget.book}</strong> ({LANG_LABEL[freeTarget.lang] ?? freeTarget.lang}) has
                  been written to '{store.folderName}' (or exported) before freeing it — this
                  cannot be undone.
                </>
              ) : (
                <>
                  No folder is connected. Export <strong>{freeTarget.book}</strong> (
                  {LANG_LABEL[freeTarget.lang] ?? freeTarget.lang}) first, or its translation will be permanently
                  lost.
                </>
              )}
            </p>
            <div class="row">
              <button onClick={() => freeRef.current?.close()}>Cancel</button>
              <button
                class="danger"
                onClick={() => {
                  freeRef.current?.close();
                  void store.freeBook(freeTarget.book, freeTarget.lang);
                }}
              >
                Free anyway
              </button>
            </div>
          </>
        ) : null}
      </dialog>

      {!groups.length ? (
        <p class="empty">
          Nothing here yet. Translate a chapter, or drop <code>.tl.json</code> files from other
          people onto this page.
        </p>
      ) : (
        <p class="hint">
          Exporting <code>.tl.json</code> files allows others to edit/merge translations on this website.
          Merging to bilingual HTML produces <code>.bilingual.html</code> files for local reading.
        </p>
      )}

      {groups.map((g) => {
        if (!g.inDb) {
          return (
            <div class="group" key={`${g.book}::${g.lang}`}>
              <h3>
                {g.book} — {LANG_LABEL[g.lang] ?? g.lang}
              </h3>
              <p class="hint">
                Found in folder ({g.folderFiles.length} file{g.folderFiles.length === 1 ? "" : "s"}):{" "}
                {g.folderFiles.join(", ")}
              </p>
              <div class="row">
                <button onClick={() => void store.loadFolderGroup(g)}>
                  Load into browser database
                </button>
              </div>
            </div>
          );
        }

        const order = orderFor(g.book);
        const missing = order.filter((c) => !g.artifacts.some((a) => a.chapter === c));
        const isDone = missing.length === 0 && g.artifacts.every((a) => !a.incomplete?.length);
        return (
          <div class="group" key={`${g.book}::${g.lang}`}>
            <h3>
              {g.book} — {LANG_LABEL[g.lang] ?? g.lang}
            </h3>
            <table>
              <thead>
                <tr>
                  <th>Chapter</th>
                  <th class="num">Lines</th>
                  <th>Model</th>
                  <th>Translated</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {g.artifacts.map((a) => (
                  <tr key={artifactKey(a)}>
                    <td>{a.chapter}</td>
                    <td class="num">
                      {a.units.length}
                      {a.incomplete?.length ? (
                        <span class="warn"> ({a.incomplete.length} missing)</span>
                      ) : null}
                    </td>
                    <td>{a.model}</td>
                    <td>{a.generatedAt ? new Date(a.generatedAt).toLocaleDateString() : "—"}</td>
                    <td class="actions">
                      <button onClick={() => store.openReview(artifactKey(a))}>Review</button>
                      <button onClick={() => download(artifactFileName(a), serializeArtifact(a))}>
                        Export
                      </button>
                      <button class="danger" onClick={() => void store.removeArtifact(artifactKey(a))}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {missing.length ? (
              <p class="hint">Still missing: {missing.join(", ")}</p>
            ) : null}

            <div class="row">
              <button onClick={() => void combine(g, false)}>Merge to bilingual HTML</button>
              {store.folderName ? (
                <button
                  onClick={() => void combine(g, true)}
                  title="Merge & write to folder"
                >
                  Merge & Write to folder
                </button>
              ) : null}
              <button
                onClick={() =>
                  download(
                    `${g.book.replace(/\.html$/i, "")}.${g.lang}.bundle.json`,
                    JSON.stringify(g.artifacts, null, 1),
                  )
                }
                title="Export all translated chapters to a bundle file"
              >
                Export All
              </button>
              {isDone ? (
                <button
                  class="danger"
                  onClick={() => {
                    setFreeTarget(g);
                    freeRef.current?.showModal();
                  }}
                >
                  Free from browser database
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
    </section>
  );

  function orderFor(bookFile: string): string[] {
    const base = normalizeBookBase(bookFile);
    for (const src of store.sources) {
      if (src.file === bookFile || normalizeBookBase(src.file) === base) {
        const book = store.books.get(src.id);
        if (book) return book.chapters.map((c) => c.name);
      }
    }
    return [];
  }

  async function combine(g: BookGroup, toFolder: boolean) {
    const order = orderFor(g.book);
    const html = combineBilingual({
      book: g.book,
      lang: g.lang,
      artifacts: g.artifacts,
      ...(order.length ? { chapterOrder: order } : {}),
      generatedAt: Date.now(),
    });
    const name = combinedFileName(g.book, g.lang);
    if (!toFolder) {
      download(name, html);
      if (!order.length) {
        store.toast("Load the original .book.html to get the chapters in book order.", "info");
      }
      return;
    }
    try {
      await fsa.writeCombined(name, html);
      store.toast(`Wrote ${name} to ${store.folderName}`);
    } catch (e) {
      store.toast((e as Error).message, "error");
    }
  }
}

function download(name: string, contents: string) {
  const blob = new Blob([contents], { type: name.endsWith(".html") ? "text/html" : "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
