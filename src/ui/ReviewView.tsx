/**
 * Read a translated chapter, pick the lines that came out wrong, redo just those.
 *
 * This is the only screen in the app that shows the translation next to its
 * source — until now that pairing existed solely in the exported bilingual file,
 * which meant a user had to leave the app to notice a bad line and had no way to
 * act on it except redoing the whole chapter.
 */
import { Fragment } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { cleanUnits } from "../scenario/cleanup";
import { renderCompact } from "../scenario/inline";
import { LANG_LABEL, type Lang } from "../scenario/model";
import { speakerName } from "../scenario/serialize";
import * as db from "../storage/db";
import {
  applyTranslations,
  artifactKey,
  shiftTranslationsByOffset,
  type Artifact,
  type ArtifactMarker,
  type ShiftDirection,
} from "../storage/exchange";
import { normalizeBookBase } from "../storage/groups";
import { FindReplacePanel } from "./FindReplaceDialog";
import { ReviewMarker, ReviewUnit, type Row } from "./ReviewUnit";
import { useStore } from "./store";
import type { Proposal, useRetranslate } from "./useRetranslate";

type Filter = "all" | "gap" | "sel";

interface ShiftDraft {
  initialSelectedIds: string[];
  artifact: Artifact;
  selectedIds: string[];
  offset: number;
}

export function ReviewView({
  retry,
  busy,
}: {
  retry: ReturnType<typeof useRetranslate>;
  busy: boolean;
}) {
  const store = useStore();
  const [find, setFind] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [hideJp, setHideJp] = useState(false);
  const [presetId, setPresetId] = useState(store.settings.presetId);
  const [hint, setHint] = useState("");
  const anchor = useRef<number | null>(null);
  const [shiftDraft, setShiftDraft] = useState<ShiftDraft | null>(null);
  const findReplaceRef = useRef<HTMLDialogElement>(null);

  // Which line's translation is open for manual edit, and which lines were touched
  // (manually or via an accepted retranslate) this session — both reset on a chapter switch.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editedIds, setEditedIds] = useState<ReadonlySet<string>>(new Set());
  const [retranslateOpen, setRetranslateOpen] = useState(false);
  useEffect(() => {
    setEditingId(null);
    setEditedIds(new Set());
    setShiftDraft(null);
    setRetranslateOpen(false);
  }, [store.reviewKey]);

  // Shifting and retranslating a selection are mutually exclusive workflows.
  useEffect(() => {
    if (shiftDraft) setRetranslateOpen(false);
  }, [shiftDraft]);

  // Always re-derived by key: a Library delete or a folder-sync merge can pull the
  // artifact out from under this screen mid-session.
  const persistedArtifact = store.artifacts.find((a) => artifactKey(a) === store.reviewKey) ?? null;
  const artifact = shiftDraft?.artifact ?? persistedArtifact;
  const selection = useMemo<ReadonlySet<string>>(
    () => new Set(shiftDraft?.selectedIds ?? store.reviewSelection),
    [shiftDraft?.selectedIds, store.reviewSelection],
  );

  const rows = useMemo(() => (artifact ? buildRows(artifact) : []), [artifact]);
  const labelCounts = useMemo(() => countByLabel(rows), [rows]);

  const shown = useMemo(() => {
    const needle = find.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === "gap" && r.translated) return false;
      if (filter === "sel" && !selection.has(r.id)) return false;
      return !needle || r.haystack.includes(needle);
    });
  }, [rows, find, filter, selection]);

  const preset = store.settings.presets.find((p) => p.id === presetId) ?? store.activePreset();
  const selectedIds = useMemo(
    () => rows.filter((r) => selection.has(r.id)).map((r) => r.id),
    [rows, selection],
  );
  const pendingIds = useMemo(() => {
    if (!shiftDraft || !persistedArtifact) return new Set<string>();
    const persisted = new Map(persistedArtifact.units.map((u) => [u.id, u.tl]));
    return new Set(
      shiftDraft.artifact.units.filter((u) => persisted.get(u.id) !== u.tl).map((u) => u.id),
    );
  }, [persistedArtifact, shiftDraft]);

  const estimate = useMemo(
    () => (artifact ? retry.estimate(artifact, selectedIds, preset, hint) : null),
    [artifact, selectedIds, preset, hint, retry],
  );

  const setSelection = store.setReviewSelection;

  const toggle = useCallback(
    (index: number, shift: boolean) => {
      if (shiftDraft) return;
      const at = anchor.current;
      if (!shift) anchor.current = index;
      setSelection((prev) => {
        const next = new Set(prev);
        if (shift && at !== null) {
          const [lo, hi] = [at, index].sort((a, b) => a - b);
          // A range applies to what is on screen, so it respects filter and find.
          for (const r of shown) if (r.index >= lo && r.index <= hi) next.add(r.id);
        } else {
          const row = rows.find((r) => r.index === index);
          if (!row) return prev;
          if (next.has(row.id)) next.delete(row.id);
          else next.add(row.id);
        }
        return next;
      });
    },
    [shown, rows, setSelection, shiftDraft],
  );

  const selectUntranslated = useCallback(() => {
    if (shiftDraft) return;
    setSelection(new Set(rows.filter((r) => !r.translated).map((r) => r.id)));
  }, [rows, setSelection, shiftDraft]);

  const startEdit = useCallback((id: string) => {
    if (!shiftDraft) setEditingId(id);
  }, [shiftDraft]);
  const cancelEdit = useCallback(() => setEditingId(null), []);

  /** Write one manually-typed line through the same path an accepted retranslation uses. */
  const saveEdit = useCallback(
    async (uid: string, text: string) => {
      if (!persistedArtifact || shiftDraft) return;
      const key = artifactKey(persistedArtifact);
      const texts = new Map([[uid, text]]);
      const meta = { model: "manual", at: Date.now() };
      await db.putUnits(key, texts, { keepPrevious: true, ...meta });
      await store.saveArtifact(applyTranslations(persistedArtifact, texts, meta));
      setEditedIds((prev) => new Set(prev).add(uid));
      setEditingId(null);
    },
    [persistedArtifact, shiftDraft, store],
  );

  /** Put back what the line held before its last edit or accepted retranslation. */
  const revertLine = useCallback(
    async (uid: string) => {
      if (!persistedArtifact || shiftDraft) return;
      await retry.revert(persistedArtifact, [uid]);
      setEditedIds((prev) => {
        const next = new Set(prev);
        next.delete(uid);
        return next;
      });
    },
    [persistedArtifact, retry, shiftDraft],
  );

  const selectLabel = useCallback(
    (id: string) => {
      if (shiftDraft) return;
      setSelection((prev) => {
        const next = new Set(prev);
        for (const r of rows) if (r.label === id) next.add(r.id);
        return next;
      });
    },
    [rows, setSelection, shiftDraft],
  );

  const shift = useCallback(
    (direction: ShiftDirection) => {
      setEditingId(null);
      setShiftDraft((prev) => {
        const base = persistedArtifact;
        const activeIds = prev?.initialSelectedIds ?? selectedIds;
        const offset = (prev?.offset ?? 0) + (direction === "up" ? -1 : 1);
        if (!base) return prev;
        const indexes = selectedIndexes(base, activeIds);
        if (!indexes) return prev;
        const result = shiftTranslationsByOffset(base.units, indexes, offset);
        if (!result) return prev;
        const nextArtifact = applyShiftPreview(base, result.translations);
        const nextSelectedIds = result.destinationIndexes.map((index) => base.units[index].id);
        return {
          initialSelectedIds: prev?.initialSelectedIds ?? [...activeIds],
          artifact: nextArtifact,
          selectedIds: nextSelectedIds,
          offset,
        };
      });
    },
    [persistedArtifact, selectedIds],
  );

  const cancelShift = useCallback(() => {
    if (!shiftDraft) return;
    setEditingId(null);
    setSelection(new Set(shiftDraft.initialSelectedIds));
    setShiftDraft(null);
  }, [setSelection, shiftDraft]);

  const confirmShift = useCallback(async () => {
    if (!shiftDraft || !persistedArtifact) return;
    const persisted = new Map(persistedArtifact.units.map((u) => [u.id, u.tl]));
    const texts = new Map<string, string>();
    for (const unit of shiftDraft.artifact.units) {
      if (persisted.get(unit.id) !== unit.tl) texts.set(unit.id, unit.tl);
    }
    if (!texts.size) {
      setShiftDraft(null);
      setSelection(new Set(shiftDraft.selectedIds));
      store.toast("No translation changes to save.");
      return;
    }

    const at = Date.now();
    const key = artifactKey(persistedArtifact);
    await db.putUnits(key, texts, { keepPrevious: true, at });
    await store.saveArtifact(
      applyTranslations(persistedArtifact, texts, {
        model: persistedArtifact.model,
        at,
        preserveModel: true,
      }),
    );
    setEditedIds((prev) => new Set([...prev, ...texts.keys()]));
    setSelection(new Set(shiftDraft.selectedIds));
    setShiftDraft(null);
    store.toast(`${texts.size} line${texts.size === 1 ? "" : "s"} shifted and saved.`);
  }, [persistedArtifact, setSelection, shiftDraft, store]);

  /**
   * Strip echoed `>alias` / `Name：` prefixes from the stored lines. Deliberately a
   * button, not an import step: it rewrites translations, so the user opts in.
   */
  const cleanUp = useCallback(async () => {
    if (!persistedArtifact || shiftDraft) return;
    const cleaned = cleanUnits(persistedArtifact.units);
    const texts = new Map<string, string>();
    cleaned.forEach((u, i) => {
      if (u !== persistedArtifact.units[i]) texts.set(u.id, u.tl);
    });
    if (!texts.size) {
      store.toast("Nothing to clean up.");
      return;
    }

    const at = Date.now();
    await db.putUnits(artifactKey(persistedArtifact), texts, { keepPrevious: true, at });
    await store.saveArtifact(
      applyTranslations(persistedArtifact, texts, { model: persistedArtifact.model, at, preserveModel: true }),
    );
    setEditedIds((prev) => new Set([...prev, ...texts.keys()]));
    store.toast(`${texts.size} line${texts.size === 1 ? "" : "s"} cleaned up.`);
  }, [persistedArtifact, shiftDraft, store]);

  const closeRetranslate = useCallback(() => {
    if (hint.trim() && !window.confirm("Discard your note?")) return;
    setRetranslateOpen(false);
  }, [hint]);

  if (!store.artifacts.length) {
    return (
      <section class="review">
        <p class="empty">
          Nothing to review yet. Translate a chapter, or drop a <code>.tl.json</code> onto the page.
        </p>
      </section>
    );
  }

  return (
    <section class={`review${retranslateOpen ? " rv-panel-open" : ""}`}>
      <div class="rv-toolbar">
        <div class="row">
          <select
            value={store.reviewKey ?? ""}
            disabled={!!shiftDraft}
            onChange={(e) => store.openReview((e.target as HTMLSelectElement).value || null)}
          >
            <option value="">— pick a chapter —</option>
            {groupArtifacts(store.artifacts).map((g) => (
              <optgroup key={`${g.book}:${g.lang}`} label={`${g.book} — ${LANG_LABEL[g.lang]}`}>
                {g.artifacts.map((a) => (
                  <option key={artifactKey(a)} value={artifactKey(a)}>
                    {a.chapter}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {artifact ? (
            <span class="hint">
              {artifact.units.length} lines
              {artifact.incomplete?.length ? ` · ${artifact.incomplete.length} untranslated` : ""}
              {" · "}
              {artifact.model || "unknown model"}
            </span>
          ) : null}
        </div>

        {artifact ? (
          <div class="row">
            <input
              class="rv-find"
              placeholder="Find in this chapter…"
              value={find}
              onInput={(e) => setFind((e.target as HTMLInputElement).value)}
            />
            <label class="rv-check">
              <input
                type="checkbox"
                checked={hideJp}
                onChange={(e) => setHideJp((e.target as HTMLInputElement).checked)}
              />{" "}
              Hide Japanese
            </label>
            <select value={filter} onChange={(e) => setFilter((e.target as HTMLSelectElement).value as Filter)}>
              <option value="all">All lines</option>
              <option value="gap">Untranslated only</option>
              <option value="sel">Selected only</option>
            </select>
            <span class="spacer" />
            <button onClick={selectUntranslated} disabled={!!shiftDraft || !artifact.incomplete?.length}>
              Select untranslated
            </button>
            <button
              onClick={() => setSelection(new Set())}
              disabled={!!shiftDraft || !selection.size}
            >
              Clear
            </button>
            <button onClick={() => findReplaceRef.current?.showModal()} disabled={!!shiftDraft}>
              Find & Replace…
            </button>
            <button
              onClick={() => void cleanUp()}
              disabled={!!shiftDraft || busy}
              title="Remove echoed >alias markers and speaker-name prefixes from the translations."
            >
              Clean up
            </button>
          </div>
        ) : null}
      </div>

      {!artifact ? (
        <p class="empty">Pick a chapter above.</p>
      ) : (
        <>
          <div class={`rv-body${hideJp ? " hide-jp" : ""}`} role="listbox" aria-multiselectable>
            {shown.map((row) => (
              <Fragment key={row.id}>
                {row.markersBefore.map((m, i) => (
                  <ReviewMarker
                    key={`${row.id}-m${i}`}
                    marker={m}
                    depth={row.depth}
                    count={m.kind === "label" ? labelCounts.get(m.id ?? "") : undefined}
                    onSelectLabel={selectLabel}
                  />
                ))}
                <ReviewUnit
                  row={row}
                  selected={selection.has(row.id)}
                  focused={false}
                  changed={editedIds.has(row.id)}
                  pending={pendingIds.has(row.id)}
                  locked={!!shiftDraft}
                  editing={!shiftDraft && editingId === row.id}
                  onToggle={toggle}
                  onEdit={startEdit}
                  onSave={saveEdit}
                  onCancelEdit={cancelEdit}
                  onRevert={revertLine}
                />
              </Fragment>
            ))}
            {!shown.length ? <p class="empty">No lines match.</p> : null}
          </div>

          <ReviewBar
            artifact={artifact}
            shiftDraft={shiftDraft}
            retry={retry}
            selectedIds={selectedIds}
            pendingCount={pendingIds.size}
            onApplied={(ids) => setEditedIds((prev) => new Set([...prev, ...ids]))}
            onShift={shift}
            onConfirmShift={confirmShift}
            onCancelShift={cancelShift}
            onOpenRetranslate={() => setRetranslateOpen(true)}
          />
        </>
      )}

      {retranslateOpen && persistedArtifact ? (
        <RetranslatePanel
          artifact={persistedArtifact}
          selectedIds={selectedIds}
          preset={presetId}
          onPreset={setPresetId}
          hint={hint}
          onHint={setHint}
          estimate={estimate}
          busy={busy}
          retry={retry}
          onClose={closeRetranslate}
          onSend={() => setRetranslateOpen(false)}
        />
      ) : null}

      <dialog
        class="help-dialog fr-dialog"
        ref={findReplaceRef}
        onClick={(e) => {
          if (findReplaceRef.current && e.target === findReplaceRef.current) {
            findReplaceRef.current.close();
          }
        }}
      >
        {persistedArtifact ? (
          <FindReplacePanel
            key={artifactKey(persistedArtifact)}
            artifact={persistedArtifact}
            rows={rows}
            onApplied={(ids) => setEditedIds((prev) => new Set([...prev, ...ids]))}
            onClose={() => findReplaceRef.current?.close()}
          />
        ) : null}
      </dialog>
    </section>
  );
}

function ReviewBar({
  artifact,
  shiftDraft,
  retry,
  selectedIds,
  pendingCount,
  onApplied,
  onShift,
  onConfirmShift,
  onCancelShift,
  onOpenRetranslate,
}: {
  artifact: Artifact;
  shiftDraft: ShiftDraft | null;
  retry: ReturnType<typeof useRetranslate>;
  selectedIds: string[];
  pendingCount: number;
  onApplied: (uids: string[]) => void;
  onShift: (direction: ShiftDirection) => void;
  onConfirmShift: () => void;
  onCancelShift: () => void;
  onOpenRetranslate: () => void;
}) {
  const s = retry.state;

  if (shiftDraft) {
    return (
      <div class="rv-bar shift pending">
        <div class="row">
          <span class="rv-pending-label">
            {pendingCount} unsaved line{pendingCount === 1 ? "" : "s"}
          </span>
          <span class="spacer" />
          <button onClick={onCancelShift}>Cancel</button>
          <button class="primary" onClick={onConfirmShift}>
            Confirm
          </button>
        </div>
        <ShiftControls
          artifact={artifact}
          selectedIds={selectedIds}
          onShift={onShift}
          onOpenRetranslate={onOpenRetranslate}
          ongoingShift
        />
      </div>
    );
  }

  // Finished: the accept/discard step.
  if (s?.finished && s.proposals.length) {
    const kept = s.proposals.filter((p) => p.keep);
    return (
      <div class="rv-bar results">
        <div class="row">
          <strong>
            {s.proposals.length} line{s.proposals.length === 1 ? "" : "s"} came back from {s.model}
          </strong>
          {s.missing.length ? (
            <span class="warn">{s.missing.length} never returned and were left alone.</span>
          ) : null}
        </div>
        <div class="rv-props">
          {s.proposals.map((p) => (
            <ProposalRow key={p.uid} p={p} onToggle={() => retry.setProposals((all) =>
              all.map((x) => (x.uid === p.uid ? { ...x, keep: !x.keep } : x)),
            )} />
          ))}
        </div>
        <div class="row">
          <button onClick={() => retry.setProposals((all) => all.map((x) => ({ ...x, keep: true })))}>
            Keep all
          </button>
          <button onClick={() => retry.setProposals((all) => all.map((x) => ({ ...x, keep: false })))}>
            Keep none
          </button>
          <span class="spacer" />
          <button onClick={retry.clear}>Discard all</button>
          <button
            disabled={!kept.length}
            onClick={() => {
              const ids = kept.map((p) => p.uid);
              void retry.apply(artifact, kept).then(() => onApplied(ids));
            }}
          >
            Apply {kept.length} kept
          </button>
        </div>
      </div>
    );
  }

  // Running.
  if (s && !s.finished) {
    return (
      <div class="rv-bar running">
        <div class="row">
          <strong>
            Retranslating {s.unitsTotal} line{s.unitsTotal === 1 ? "" : "s"} with {s.model}
          </strong>
          <span class="spacer" />
          <button class="danger" onClick={retry.stop}>
            Stop
          </button>
        </div>
        <progress value={s.requestsDone} max={s.requestsTotal} />
        <div class="counters">
          <span>
            {s.requestsDone}/{s.requestsTotal} calls
          </span>
          <span>
            {s.usage.promptTokens.toLocaleString()} in / {s.usage.completionTokens.toLocaleString()} out
          </span>
        </div>
        {s.waiting ? (
          <p class="waiting">
            Waiting {Math.ceil(s.waiting.ms / 1000)}s — {waitReason(s.waiting.reason)}
          </p>
        ) : null}
        <ol class="log">
          {s.log.slice(-4).reverse().map((l, i) => (
            <li key={i} class={l.kind}>
              <time>{new Date(l.at).toLocaleTimeString()}</time> {l.text}
            </li>
          ))}
        </ol>
      </div>
    );
  }

  // Errored, or nothing came back.
  if (s?.finished) {
    return (
      <div class="rv-bar">
        <span class={s.error ? "warn" : "hint"}>{s.error ?? "Nothing came back."}</span>
        <span class="spacer" />
        <button onClick={retry.clear}>Dismiss</button>
      </div>
    );
  }

  if (!selectedIds.length) return null;

  return (
    <div class="rv-bar">
      <ShiftControls artifact={artifact} selectedIds={selectedIds} onShift={onShift} onOpenRetranslate={onOpenRetranslate} />
    </div>
  );
}

/**
 * Docked, non-modal — the row list must stay clickable while this is open so the
 * user can keep adjusting the selection right up until Send.
 */
function RetranslatePanel({
  artifact,
  selectedIds,
  preset,
  onPreset,
  hint,
  onHint,
  estimate,
  busy,
  retry,
  onClose,
  onSend,
}: {
  artifact: Artifact;
  selectedIds: string[];
  preset: string;
  onPreset: (id: string) => void;
  hint: string;
  onHint: (s: string) => void;
  estimate: ReturnType<ReturnType<typeof useRetranslate>["estimate"]>;
  busy: boolean;
  retry: ReturnType<typeof useRetranslate>;
  onClose: () => void;
  onSend: () => void;
}) {
  const store = useStore();
  const chosen = store.settings.presets.find((p) => p.id === preset) ?? store.activePreset();
  const used = store.settings.limiter[chosen.id]?.dayRequests ?? 0;
  const left = chosen.limits.rpd ? chosen.limits.rpd - used : 0;

  return (
    <aside class="help-dialog rv-retranslate-panel">
      <div class="help-dialog-header">
        <h2>
          Retranslate {selectedIds.length} line{selectedIds.length === 1 ? "" : "s"}
        </h2>
        <button class="help-dialog-close" onClick={onClose}>
          ✕
        </button>
      </div>

      <div class="row">
        <select value={preset} onChange={(e) => onPreset((e.target as HTMLSelectElement).value)}>
          {store.settings.presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      <textarea
        class="rv-note"
        rows={4}
        placeholder='Optional note for these lines (e.g. "テンジン is a character name — keep it")'
        value={hint}
        onInput={(e) => onHint((e.target as HTMLTextAreaElement).value)}
      />

      {estimate ? (
        <p class="est">
          {estimate.calls} call{estimate.calls === 1 ? "" : "s"} · ~
          {estimate.inputTokens.toLocaleString()} in / ~{estimate.outputTokens.toLocaleString()} out
          {" · "}
          {estimate.contextLines} context line{estimate.contextLines === 1 ? "" : "s"}
          {chosen.limits.rpd ? ` · ${left} of ${chosen.limits.rpd} requests left today` : ""}
        </p>
      ) : null}
      <p class="hint">Nearby lines are sent as context but are not changed.</p>

      <div class="row help-dialog-footer">
        <span class="spacer" />
        <button onClick={onClose}>Cancel</button>
        <button
          class="primary"
          disabled={busy || !selectedIds.length}
          title={busy ? "A translation is already running." : ""}
          onClick={() => {
            void retry.start(artifact, selectedIds, chosen, hint);
            onSend();
          }}
        >
          Retranslate {selectedIds.length}
        </button>
      </div>
    </aside>
  );
}

function ShiftControls({
  artifact,
  selectedIds,
  onShift,
  onOpenRetranslate,
  ongoingShift = false,
}: {
  artifact: Artifact;
  selectedIds: string[];
  onShift: (direction: ShiftDirection) => void;
  onOpenRetranslate: () => void;
  ongoingShift?: boolean;
}) {
  const indexes = selectedIndexes(artifact, selectedIds);
  const canShift = !!indexes;
  const canUp = canShift && indexes![0] > 0;
  const canDown = canShift && indexes![indexes!.length - 1] < artifact.units.length - 1;
  const guidance = !selectedIds.length
    ? "Select a continuous range to shift."
    : !canShift
      ? "Shift requires one continuous range of lines."
      : `Rows ${indexes![0] + 1}–${indexes![indexes!.length - 1] + 1} selected`;

  return (
    <div class="row rv-shift-controls">
      <span class="hint">{guidance}</span>
      <span class="spacer" />
      {!ongoingShift ? (
        <button onClick={onOpenRetranslate}>Retranslate {selectedIds.length}</button>
      ) : null}
      <button
        disabled={!canUp}
        title={canShift ? (canUp ? "Move selected translations up one row." : "The selection is already at the first row.") : guidance}
        onClick={() => onShift("up")}
      >
        Shift up
      </button>
      <button
        disabled={!canDown}
        title={canShift ? (canDown ? "Move selected translations down one row." : "The selection is already at the last row.") : guidance}
        onClick={() => onShift("down")}
      >
        Shift down
      </button>
    </div>
  );
}

function ProposalRow({ p, onToggle }: { p: Proposal; onToggle: () => void }) {
  return (
    <div class={`rv-prop${p.keep ? " keep" : ""}`}>
      <input type="checkbox" checked={p.keep} onChange={onToggle} />
      <div>
        <div class="rv-jp" dangerouslySetInnerHTML={{ __html: renderCompact(p.src) }} />
        <div class="rv-was">
          {p.previous || <em>(was untranslated)</em>}
        </div>
        <div
          class="rv-new"
          dangerouslySetInnerHTML={{ __html: renderCompact(p.next, { ruby: false }) }}
        />
      </div>
    </div>
  );
}

/** Same grouping the Library uses. */
export function groupArtifacts(artifacts: Artifact[]) {
  const groups = new Map<string, { book: string; lang: Lang; artifacts: Artifact[] }>();
  for (const a of artifacts) {
    const base = normalizeBookBase(a.book);
    const key = `${base}::${a.lang}`;
    const g = groups.get(key);
    if (g) g.artifacts.push(a);
    else groups.set(key, { book: a.book, lang: a.lang, artifacts: [a] });
  }
  for (const g of groups.values()) g.artifacts.sort((x, y) => x.chapter.localeCompare(y.chapter));
  return [...groups.values()];
}

function buildRows(a: Artifact): Row[] {
  const byIndex = new Map<number, ArtifactMarker[]>();
  for (const m of a.markers) {
    const at = byIndex.get(m.at);
    if (at) at.push(m);
    else byIndex.set(m.at, [m]);
  }

  const rows: Row[] = [];
  let depth = 0;
  let label: string | null = null;

  a.units.forEach((u, i) => {
    const markers = byIndex.get(i) ?? [];
    for (const m of markers) {
      if (m.kind === "label") label = m.id ?? null;
      if (m.kind === "cond") depth++;
      else if (m.kind === "cond-end") depth = Math.max(0, depth - 1);
    }
    const chara = u.speaker ? speakerName(u.speaker, a.lang) : "";
    rows.push({
      index: i,
      id: u.id,
      kind: u.kind,
      srcHtml: renderCompact(u.src, { sizes: u.sizes }),
      tlHtml: renderCompact(u.tl, { ruby: false, sizes: u.sizes }),
      tl: u.tl,
      charaTl: chara,
      charaJp: u.speaker?.jp ?? "",
      ...(u.kind === "select" && u.to ? { to: u.to } : {}),
      label,
      haystack: `${u.src}\n${u.tl}`.toLowerCase(),
      translated: !!u.tl,
      markersBefore: markers,
      depth,
    });
  });

  return rows;
}

function selectedIndexes(a: Artifact, ids: readonly string[]): number[] | null {
  if (!ids.length) return null;
  const byId = new Map(a.units.map((unit, index) => [unit.id, index]));
  const indexes = ids
    .map((id) => byId.get(id))
    .filter((index): index is number => index !== undefined)
    .sort((x, y) => x - y);
  if (
    indexes.length !== ids.length ||
    indexes.some((index, i) => i > 0 && index !== indexes[i - 1] + 1)
  ) {
    return null;
  }
  return indexes;
}

function applyShiftPreview(a: Artifact, translations: Map<string, string>): Artifact {
  const units = a.units.map((unit) =>
    translations.has(unit.id) ? { ...unit, tl: translations.get(unit.id)! } : unit,
  );
  const incomplete = units.filter((unit) => !unit.tl).map((unit) => unit.id);
  const { incomplete: _was, ...rest } = a;
  return {
    ...rest,
    units,
    ...(incomplete.length ? { incomplete } : {}),
  };
}

function countByLabel(rows: Row[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (!r.label) continue;
    counts.set(r.label, (counts.get(r.label) ?? 0) + 1);
  }
  return counts;
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
