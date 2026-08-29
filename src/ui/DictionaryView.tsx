import { useMemo, useRef, useState } from "preact/hooks";
import { LANGS, LANG_LABEL, type Lang } from "../scenario/model";
import { useStore } from "./store";

export function DictionaryView() {
  const store = useStore();
  const [lang, setLang] = useState<Lang>(store.settings.targetLang);
  const [search, setSearch] = useState("");
  const [newJp, setNewJp] = useState("");
  const [newTl, setNewTl] = useState("");
  const importFileRef = useRef<HTMLInputElement>(null);

  const dictionary = store.settings.dictionary ?? { en: {}, "zh-hans": {}, "zh-hant": {} };
  const currentLangEntries = useMemo(() => {
    const map = dictionary[lang] ?? {};
    return Object.entries(map).map(([jp, tl]) => ({ jp, tl }));
  }, [dictionary, lang]);

  const filteredEntries = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return currentLangEntries;
    return currentLangEntries.filter(
      (e) => e.jp.toLowerCase().includes(query) || e.tl.toLowerCase().includes(query),
    );
  }, [currentLangEntries, search]);

  const totalAllLangs = useMemo(() => {
    let count = 0;
    for (const l of LANGS) {
      count += Object.keys(dictionary[l] ?? {}).length;
    }
    return count;
  }, [dictionary]);

  const handleAdd = (e?: Event) => {
    if (e) e.preventDefault();
    const jp = newJp.trim();
    const tl = newTl.trim();
    if (!jp) {
      store.toast("Please enter an original character name.", "error");
      return;
    }
    if (!tl) {
      store.toast("Please enter a translated character name.", "error");
      return;
    }
    void store.updateDictionaryName(lang, jp, tl);
    setNewJp("");
    setNewTl("");
    store.toast(`Added name translation: ${jp} = ${tl}`);
  };

  const handleImportFiles = async () => {
    const count = await store.importCustomNamesToDictionary();
    if (count > 0) {
      store.toast(`Imported ${count} name translation(s) from loaded source files.`);
    } else {
      store.toast("No new character names found in loaded files.");
    }
  };

  const handleExportJson = () => {
    const blob = new Blob([JSON.stringify(dictionary, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dictionary.json`;
    a.click();
    URL.revokeObjectURL(url);
    store.toast("Exported global dictionary to JSON.");
  };

  const handleImportJson = (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const text = evt.target?.result as string;
        const parsed = JSON.parse(text);
        let count = 0;
        if (typeof parsed === "object" && parsed !== null) {
          // Could be full dictionary { en: {...}, "zh-hans": {...} } or a flat mapping { "name": "tl" }
          const isFlat = !LANGS.some((l) => l in parsed);
          if (isFlat) {
            count = await store.importDictionary({ [lang]: parsed });
          } else {
            count = await store.importDictionary(parsed);
          }
          store.toast(`Successfully imported ${count} name translation(s).`);
        }
      } catch (err) {
        store.toast(`Failed to parse dictionary JSON: ${(err as Error).message}`, "error");
      }
      (e.target as HTMLInputElement).value = "";
    };
    reader.readAsText(file);
  };

  const handleClear = async () => {
    if (
      window.confirm(
        `Are you sure you want to clear all ${currentLangEntries.length} entries for ${LANG_LABEL[lang]}?`,
      )
    ) {
      await store.clearDictionary(lang);
      store.toast(`Cleared dictionary entries for ${LANG_LABEL[lang]}.`);
    }
  };

  return (
    <section class="dictionary-view">
      <div class="dictionary-header">
        <div>
          <h2>Global Character Dictionary</h2>
          <p class="hint">
            Manage global name translations used during scanning and prompt generation.
            Names added here are automatically shared across all books.
          </p>
        </div>
        <div class="dictionary-stats">
          <span class="badge">
            {currentLangEntries.length} for {LANG_LABEL[lang]}
          </span>
          <span class="badge secondary">{totalAllLangs} total</span>
        </div>
      </div>

      <div class="row dictionary-toolbar">
        <select
            value={lang}
            onChange={(e) => setLang((e.target as HTMLSelectElement).value as Lang)}
          >
          {LANGS.map((l) => (
            <option key={l} value={l}>
              {LANG_LABEL[l]}
            </option>
          ))}
        </select>

        <input
          type="search"
          class="dictionary-search"
          placeholder="Filter names..."
          value={search}
          onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
        />

        <span class="spacer" />

        <button onClick={handleImportFiles} title="Scan loaded books for custom names">
          Import from loaded files
        </button>
        <button onClick={handleExportJson} title="Export entire dictionary to JSON">
          Export JSON
        </button>
        <button onClick={() => importFileRef.current?.click()} title="Import dictionary from JSON file">
          Import JSON…
        </button>
        <input
          ref={importFileRef}
          type="file"
          accept=".json"
          hidden
          onChange={handleImportJson}
        />
        {currentLangEntries.length > 0 ? (
          <button class="danger" onClick={handleClear}>
            Clear ({LANG_LABEL[lang]})
          </button>
        ) : null}
      </div>

      <form class="dictionary-add-form" onSubmit={handleAdd}>
        <h3>Add Name Translation ({LANG_LABEL[lang]})</h3>
        <div class="row">
          <input
            type="text"
            placeholder="Original Name (e.g. タサブロウ)"
            value={newJp}
            onInput={(e) => setNewJp((e.target as HTMLInputElement).value)}
          />
          <span class="eq">=</span>
          <input
            type="text"
            placeholder="Translated Name (e.g. Tasaburou)"
            value={newTl}
            onInput={(e) => setNewTl((e.target as HTMLInputElement).value)}
          />
          <button type="submit">Add Entry</button>
        </div>
      </form>

      <div class="dictionary-list">
        {filteredEntries.length === 0 ? (
          <p class="empty">
            {search
              ? `No entries match "${search}".`
              : `No global name translations for ${LANG_LABEL[lang]} yet. Add one above or import from loaded source files.`}
          </p>
        ) : (
          <table class="dictionary-table">
            <thead>
              <tr>
                <th>Original Name (JP)</th>
                <th>Translated Name ({LANG_LABEL[lang]})</th>
                <th class="actions-col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredEntries.map(({ jp, tl }) => (
                <DictionaryRow
                  key={jp}
                  jp={jp}
                  tl={tl}
                  onSave={(val) => void store.updateDictionaryName(lang, jp, val)}
                  onDelete={() => void store.deleteDictionaryName(lang, jp)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function DictionaryRow({
  jp,
  tl,
  onSave,
  onDelete,
}: {
  jp: string;
  tl: string;
  onSave: (val: string) => void;
  onDelete: () => void;
}) {
  const [value, setValue] = useState(tl);

  return (
    <tr>
      <td class="jp-name">
        <code>{jp}</code>
      </td>
      <td class="tl-name">
        <input
          type="text"
          value={value}
          onInput={(e) => setValue((e.target as HTMLInputElement).value)}
          onBlur={() => {
            if (value !== tl) onSave(value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
      </td>
      <td class="actions-col">
        <button class="danger btn-sm" onClick={onDelete} title="Delete entry">
          Delete
        </button>
      </td>
    </tr>
  );
}
