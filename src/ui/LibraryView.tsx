/**
 * Everything translated so far: export it, share it, merge other people's, and
 * combine it into one readable bilingual file.
 */
import { useMemo, useRef, useState } from "preact/hooks";
import { combineBilingual, combinedFileName } from "../combine/bilingual";
import { LANG_LABEL, type Lang } from "../scenario/model";
import {
  artifactFileName,
  artifactKey,
  serializeArtifact,
  type Artifact,
} from "../storage/exchange";
import * as fsa from "../storage/fsa";
import { useStore } from "./store";

interface Group {
  book: string;
  lang: Lang;
  artifacts: Artifact[];
}

export function LibraryView() {
  const store = useStore();
  const folderIntroRef = useRef<HTMLDialogElement>(null);
  const freeRef = useRef<HTMLDialogElement>(null);
  const [freeTarget, setFreeTarget] = useState<Group | null>(null);

  const groups = useMemo<Group[]>(() => {
    const map = new Map<string, Group>();
    for (const a of store.artifacts) {
      const key = `${a.book}::${a.lang}`;
      const g = map.get(key) ?? { book: a.book, lang: a.lang, artifacts: [] };
      g.artifacts.push(a);
      map.set(key, g);
    }
    for (const g of map.values()) g.artifacts.sort((x, y) => x.chapter.localeCompare(y.chapter));
    return [...map.values()];
  }, [store.artifacts]);

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

      {store.folderName ? (
        store.folderFiles.length ? (
          <ul class="folder-files">
            {store.folderFiles.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        ) : (
          <p class="hint">Click Refresh to list files in this folder.</p>
        )
      ) : null}

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
                  Make sure <strong>{freeTarget.book}</strong> ({LANG_LABEL[freeTarget.lang]}) has
                  been written to '{store.folderName}' (or exported) before freeing it — this
                  cannot be undone.
                </>
              ) : (
                <>
                  No folder is connected. Export <strong>{freeTarget.book}</strong> (
                  {LANG_LABEL[freeTarget.lang]}) first, or its translation will be permanently
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
      ) : null}

      {groups.map((g) => {
        const order = orderFor(g.book);
        const missing = order.filter((c) => !g.artifacts.some((a) => a.chapter === c));
        const isDone = missing.length === 0 && g.artifacts.every((a) => !a.incomplete?.length);
        return (
          <div class="group" key={`${g.book}::${g.lang}`}>
            <h3>
              {g.book} — {LANG_LABEL[g.lang]}
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
              <button onClick={() => void combine(g, false)}>Combine to bilingual HTML</button>
              {store.folderName ? (
                <button onClick={() => void combine(g, true)}>Combine into the folder</button>
              ) : null}
              <button
                onClick={() =>
                  download(
                    `${g.book.replace(/\.html$/i, "")}.${g.lang}.bundle.json`,
                    JSON.stringify(g.artifacts, null, 1),
                  )
                }
              >
                Export all as one file
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
    for (const src of store.sources) {
      if (src.file !== bookFile) continue;
      const book = store.books.get(src.id);
      if (book) return book.chapters.map((c) => c.name);
    }
    return [];
  }

  async function combine(g: Group, toFolder: boolean) {
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
