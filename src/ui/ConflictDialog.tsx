/**
 * The dialogs that show what an import or backup will change, and ask about clashes.
 *
 * Both are driven by a plan from `storage/importPlan.ts` / `storage/dictPlan.ts`;
 * the store only opens one when the plan has a decision in it. Cancel writes
 * nothing anywhere.
 */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { renderCompact } from "../scenario/inline";
import { LANG_LABEL, LANGS } from "../scenario/model";
import { speakerName } from "../scenario/serialize";
import {
  allDictChoices,
  defaultDictChoices,
  isDecision,
  type DictChoices,
  type DictDiff,
  type DictPlan,
} from "../storage/dictPlan";
import {
  allChoices,
  defaultChoices,
  filledCount,
  type ChapterPlan,
  type ImportChoices,
  type LineConflict,
  type Side,
} from "../storage/importPlan";

/** Above this many conflicting lines, chapters start collapsed. */
const EXPAND_LIMIT = 40;

/**
 * Open as a modal; Esc, ✕ and Cancel all go through `cancel`, which does nothing while
 * `busy` — the writes are already under way, so "nothing was changed" would be false.
 */
function useModal(onCancel: () => void, busy: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);
  const cancel = () => {
    if (!busy) onCancel();
  };
  // Esc closes a native dialog; treat it as Cancel so state stays in step.
  const onDialogCancel = (e: Event) => {
    e.preventDefault();
    cancel();
  };
  return { ref, cancel, onDialogCancel };
}

export function ImportConflictDialog({
  plan,
  label,
  onApply,
  onCancel,
}: {
  plan: ChapterPlan[];
  label: string;
  onApply: (choices: ImportChoices) => Promise<void>;
  onCancel: () => void;
}) {
  const [choices, setChoices] = useState<ImportChoices>(() => defaultChoices(plan));
  const [applying, setApplying] = useState(false);
  const { ref, cancel, onDialogCancel } = useModal(onCancel, applying);

  const decided = plan.filter((c) => c.kind === "version-mismatch" || c.conflicts.length);
  const quiet = plan.filter((c) => !decided.includes(c));
  const totalConflicts = decided.reduce((n, c) => n + c.conflicts.length, 0);
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () => new Set(totalConflicts <= EXPAND_LIMIT ? decided.map((c) => c.key) : []),
  );
  const multiBook = new Set(plan.map((c) => c.book)).size > 1;

  const counts = useMemo(() => {
    let fills = 0;
    let incoming = 0;
    let mine = 0;
    for (const c of plan) {
      fills += c.fills.length;
      for (const l of c.conflicts) {
        if ((choices.lines[c.key]?.[l.uid] ?? l.suggested) === "incoming") incoming++;
        else mine++;
      }
    }
    return {
      fills,
      incoming,
      mine,
      newChapters: plan.filter((c) => c.kind === "new").length,
      identical: plan.filter((c) => c.kind === "identical").length,
    };
  }, [plan, choices]);

  const setLine = (key: string, uid: string, side: Side) =>
    setChoices((prev) => ({ ...prev, lines: { ...prev.lines, [key]: { ...prev.lines[key], [uid]: side } } }));
  const setChapterLines = (c: ChapterPlan, side: Side) =>
    setChoices((prev) => ({
      ...prev,
      lines: { ...prev.lines, [c.key]: Object.fromEntries(c.conflicts.map((l) => [l.uid, side])) },
    }));
  const setChapter = (key: string, side: Side) =>
    setChoices((prev) => ({ ...prev, chapters: { ...prev.chapters, [key]: side } }));
  const toggleOpen = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const apply = async () => {
    setApplying(true);
    try {
      await onApply(choices);
    } finally {
      setApplying(false);
    }
  };

  return (
    <dialog class="help-dialog fr-dialog conflict-dialog" ref={ref} onCancel={onDialogCancel}>
      <div class="help-dialog-header">
        <h2>Import {label}</h2>
        <button class="help-dialog-close" aria-label="Cancel import" disabled={applying} onClick={cancel}>
          ✕
        </button>
      </div>

      <p class="hint">
        {[
          counts.newChapters ? `${counts.newChapters} new chapter${plural(counts.newChapters)}` : "",
          counts.fills ? `${counts.fills} empty line${plural(counts.fills)} filled in` : "",
          counts.identical ? `${counts.identical} unchanged` : "",
        ]
          .filter(Boolean)
          .join(" · ")}
        {totalConflicts ? (
          <>
            {counts.newChapters || counts.fills || counts.identical ? " · " : ""}
            <strong>
              {totalConflicts} line{plural(totalConflicts)} differ{totalConflicts === 1 ? "s" : ""}
            </strong>{" "}
            ({counts.incoming} from file, {counts.mine} kept)
          </>
        ) : null}
      </p>
      <p class="hint">
        Suggestions pick whichever side was written more recently. Lines that differ only by an
        echoed speaker name count as the same.
      </p>

      <div class="cf-list">
        {decided.map((c) =>
          c.kind === "version-mismatch" ? (
            <MismatchRow
              key={c.key}
              c={c}
              multiBook={multiBook}
              side={choices.chapters[c.key] ?? c.suggested ?? "mine"}
              onPick={(s) => setChapter(c.key, s)}
            />
          ) : (
            <ChapterRow
              key={c.key}
              c={c}
              multiBook={multiBook}
              picked={choices.lines[c.key] ?? {}}
              expanded={open.has(c.key)}
              onToggle={() => toggleOpen(c.key)}
              onPickAll={(s) => setChapterLines(c, s)}
              onPick={(uid, s) => setLine(c.key, uid, s)}
            />
          ),
        )}
        {quiet.length ? (
          <details class="cf-quiet">
            <summary>
              {quiet.length} other chapter{plural(quiet.length)} with nothing to decide
            </summary>
            <ul>
              {quiet.map((c) => (
                <li key={c.key}>
                  {chapterTitle(c, multiBook)} —{" "}
                  {c.kind === "new"
                    ? `new, ${filledCount(c.incoming)} line${plural(filledCount(c.incoming))}`
                    : c.kind === "identical"
                      ? "unchanged"
                      : `${c.fills.length} empty line${plural(c.fills.length)} filled in`}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>

      <div class="row help-dialog-footer">
        <button onClick={() => setChoices(allChoices(plan, "mine"))}>Keep all mine</button>
        <button onClick={() => setChoices(allChoices(plan, "incoming"))}>Take all from file</button>
        <button onClick={() => setChoices(defaultChoices(plan))}>Use suggestions</button>
        <span class="spacer" />
        <button disabled={applying} onClick={cancel}>
          Cancel
        </button>
        <button class="primary" disabled={applying} onClick={() => void apply()}>
          Import
        </button>
      </div>
    </dialog>
  );
}

function ChapterRow({
  c,
  multiBook,
  picked,
  expanded,
  onToggle,
  onPickAll,
  onPick,
}: {
  c: ChapterPlan;
  multiBook: boolean;
  picked: Record<string, Side>;
  expanded: boolean;
  onToggle: () => void;
  onPickAll: (s: Side) => void;
  onPick: (uid: string, s: Side) => void;
}) {
  const sides = c.conflicts.map((l) => picked[l.uid] ?? l.suggested);
  const fromFile = sides.filter((s) => s === "incoming").length;
  const bulk = fromFile === 0 ? "mine" : fromFile === sides.length ? "incoming" : "mixed";

  return (
    <div class="cf-chapter">
      <div class="cf-chapter-head">
        <button class="link cf-caret" aria-expanded={expanded} onClick={onToggle}>
          {expanded ? "▾" : "▸"} {chapterTitle(c, multiBook)}
        </button>
        <span class="cf-badges">
          {c.fills.length ? <span class="badge secondary">+{c.fills.length} filled</span> : null}
          <span class="badge">
            {c.conflicts.length} differ{c.conflicts.length === 1 ? "s" : ""}
          </span>
        </span>
        <span class="spacer" />
        <select
          value={bulk}
          aria-label={`Choice for every differing line in ${c.chapter}`}
          onChange={(e) => {
            const v = (e.target as HTMLSelectElement).value;
            if (v === "mine" || v === "incoming") onPickAll(v);
          }}
        >
          <option value="mine">Keep mine</option>
          <option value="incoming">Take from file</option>
          <option value="mixed" disabled>
            Mixed ({fromFile}/{sides.length} from file)
          </option>
        </select>
      </div>
      {expanded ? (
        <div class="cf-lines">
          {c.conflicts.map((l) => (
            <LineRow
              key={l.uid}
              group={`cf-${c.key}::${l.uid}`}
              l={l}
              lang={c.lang}
              side={picked[l.uid] ?? l.suggested}
              onPick={(s) => onPick(l.uid, s)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function LineRow({
  group,
  l,
  lang,
  side,
  onPick,
}: {
  /** Radio group name; uids repeat across chapters (the same chapter in two languages). */
  group: string;
  l: LineConflict;
  lang: ChapterPlan["lang"];
  side: Side;
  onPick: (s: Side) => void;
}) {
  return (
    <div class="cf-line">
      <div class="cf-src">
        <span class="cf-uid">{l.uid}</span>
        {l.speaker ? <span class="rv-chara">{speakerName(l.speaker, lang)}</span> : null}
        <span class="rv-jp" dangerouslySetInnerHTML={{ __html: renderCompact(l.src) }} />
      </div>
      {(["mine", "incoming"] as const).map((s) => (
        <label key={s} class={`cf-option${side === s ? " picked" : ""}`}>
          <input type="radio" name={group} checked={side === s} onChange={() => onPick(s)} />
          <span class="cf-side">
            {s === "mine" ? "Mine" : "File"}
            <span class="cf-time">{formatTime(s === "mine" ? l.mineAt : l.incomingAt)}</span>
            {l.suggested === s ? <span class="cf-suggested">newer</span> : null}
          </span>
          <span
            class="cf-text"
            dangerouslySetInnerHTML={{
              __html: renderCompact(s === "mine" ? l.mine : l.incoming, { ruby: false }),
            }}
          />
        </label>
      ))}
    </div>
  );
}

function MismatchRow({
  c,
  multiBook,
  side,
  onPick,
}: {
  c: ChapterPlan;
  multiBook: boolean;
  side: Side;
  onPick: (s: Side) => void;
}) {
  const mine = c.mine!;
  const name = `cf-ch-${c.key}`;
  return (
    <div class="cf-chapter cf-mismatch">
      <div class="cf-chapter-head">
        <strong>{chapterTitle(c, multiBook)}</strong>
        <span class="badge warn">different book version</span>
      </div>
      <p class="hint">
        The file was translated from a different version of the Japanese source, so its lines
        can't be matched up. Keep one chapter whole.
      </p>
      {(["mine", "incoming"] as const).map((s) => {
        const a = s === "mine" ? mine : c.incoming;
        return (
          <label key={s} class={`cf-option${side === s ? " picked" : ""}`}>
            <input type="radio" name={name} checked={side === s} onChange={() => onPick(s)} />
            <span class="cf-side">
              {s === "mine" ? "Mine" : "File"}
              <span class="cf-time">{formatTime(a.generatedAt)}</span>
              {c.suggested === s ? <span class="cf-suggested">suggested</span> : null}
            </span>
            <span class="cf-text">
              {filledCount(a)}/{a.units.length} lines translated
              {a.model ? ` · ${a.model}` : ""}
            </span>
          </label>
        );
      })}
    </div>
  );
}

export function DictConflictDialog({
  plan,
  label,
  onApply,
  onCancel,
}: {
  plan: DictPlan;
  label: string;
  onApply: (choices: DictChoices) => Promise<void>;
  onCancel: () => void;
}) {
  const [choices, setChoices] = useState<DictChoices>(() => defaultDictChoices(plan));
  const [applying, setApplying] = useState(false);
  const { ref, cancel, onDialogCancel } = useModal(onCancel, applying);
  const backup = plan.mode === "backup";
  const theirsLabel = backup ? "Folder" : "File";

  const decisions = plan.diffs.filter(isDecision);
  const automatic = plan.diffs.filter((d) => !isDecision(d));
  const byLang = LANGS.map((lang) => ({ lang, rows: decisions.filter((d) => d.lang === lang) })).filter(
    (g) => g.rows.length,
  );
  const pick = (d: DictDiff, side: "mine" | "theirs") => setChoices((prev) => ({ ...prev, [d.id]: side }));

  const apply = async () => {
    setApplying(true);
    try {
      await onApply(choices);
    } finally {
      setApplying(false);
    }
  };

  return (
    <dialog class="help-dialog fr-dialog conflict-dialog" ref={ref} onCancel={onDialogCancel}>
      <div class="help-dialog-header">
        <h2>{backup ? `Back up dictionary to ${label}` : `Import dictionary ${label}`}</h2>
        <button class="help-dialog-close" aria-label="Cancel" disabled={applying} onClick={cancel}>
          ✕
        </button>
      </div>
      <p class="hint">
        {backup
          ? "The folder's dictionary.json differs from this browser. The result is saved to both."
          : "Entries only in the file are added; entries only in this browser are kept."}
      </p>

      <div class="cf-list">
        {byLang.map(({ lang, rows }) => (
          <div key={lang} class="cf-chapter">
            <div class="cf-chapter-head">
              <strong>{LANG_LABEL[lang]}</strong>
              <span class="badge">{rows.length}</span>
            </div>
            <div class="cf-lines">
              {rows.map((d) =>
                d.kind === "clash" ? (
                  <div key={d.id} class="cf-line">
                    <div class="cf-src">
                      <code>{d.key}</code>
                    </div>
                    {(["mine", "theirs"] as const).map((s) => (
                      <label key={s} class={`cf-option${choices[d.id] === s ? " picked" : ""}`}>
                        <input
                          type="radio"
                          name={`dict-${d.id}`}
                          checked={choices[d.id] === s}
                          onChange={() => pick(d, s)}
                        />
                        <span class="cf-side">{s === "mine" ? "Browser" : theirsLabel}</span>
                        <span class="cf-text">{s === "mine" ? d.mine : d.theirs}</span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <div key={d.id} class="cf-line">
                    <label class={`cf-option${choices[d.id] === "theirs" ? " picked" : ""}`}>
                      <input
                        type="checkbox"
                        checked={choices[d.id] === "theirs"}
                        onChange={(e) => pick(d, (e.target as HTMLInputElement).checked ? "theirs" : "mine")}
                      />
                      <span class="cf-side">
                        <code>{d.key}</code>
                      </span>
                      <span class="cf-text">
                        {d.theirs} <em class="hint">— only in the folder; tick to keep it (adds it here too)</em>
                      </span>
                    </label>
                  </div>
                ),
              )}
            </div>
          </div>
        ))}
        {automatic.length ? (
          <details class="cf-quiet">
            <summary>
              {automatic.length} {backup ? "entr" : "new entr"}
              {automatic.length === 1 ? "y" : "ies"} {backup ? "only in this browser, written to the folder" : "added from the file"}
            </summary>
            <ul>
              {automatic.map((d) => (
                <li key={d.id}>
                  {LANG_LABEL[d.lang]}: <code>{d.key}</code> = {d.mine ?? d.theirs}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>

      <div class="row help-dialog-footer">
        <button onClick={() => setChoices(allDictChoices(plan, "mine"))}>
          {backup ? "Browser wins" : "Keep all mine"}
        </button>
        <button onClick={() => setChoices(allDictChoices(plan, "theirs"))}>
          {backup ? "Keep all from folder" : "Take all from file"}
        </button>
        <span class="spacer" />
        <button disabled={applying} onClick={cancel}>
          Cancel
        </button>
        <button class="primary" disabled={applying} onClick={() => void apply()}>
          {backup ? "Back up" : "Import"}
        </button>
      </div>
    </dialog>
  );
}

function chapterTitle(c: ChapterPlan, multiBook: boolean): string {
  const book = c.book.replace(/\.book\.html$/i, "").replace(/\.html$/i, "");
  return `${multiBook ? `${book} · ` : ""}${c.chapter} (${c.lang})`;
}

function formatTime(t: number): string {
  if (!t) return "unknown time";
  return new Date(t).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}
