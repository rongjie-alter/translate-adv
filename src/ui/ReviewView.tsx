/**
 * Read a translated chapter, pick the lines that came out wrong, redo just those.
 *
 * This is the only screen in the app that shows the translation next to its
 * source — until now that pairing existed solely in the exported bilingual file,
 * which meant a user had to leave the app to notice a bad line and had no way to
 * act on it except redoing the whole chapter.
 */
import { Fragment } from "preact";
import { useCallback, useMemo, useRef, useState } from "preact/hooks";
import { renderCompact } from "../scenario/inline";
import { LANG_LABEL, type Lang } from "../scenario/model";
import { speakerName } from "../scenario/serialize";
import { artifactKey, type Artifact, type ArtifactMarker } from "../storage/exchange";
import { ReviewMarker, ReviewUnit, type Row } from "./ReviewUnit";
import { useStore } from "./store";
import type { Proposal, useRetranslate } from "./useRetranslate";

type Filter = "all" | "gap" | "sel";

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

  // Always re-derived by key: a Library delete or a folder-sync merge can pull the
  // artifact out from under this screen mid-session.
  const artifact = store.artifacts.find((a) => artifactKey(a) === store.reviewKey) ?? null;
  const selection = store.reviewSelection;

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

  const estimate = useMemo(
    () => (artifact ? retry.estimate(artifact, selectedIds, preset, hint) : null),
    [artifact, selectedIds, preset, hint, retry],
  );

  const setSelection = store.setReviewSelection;

  const toggle = useCallback(
    (index: number, shift: boolean) => {
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
    [shown, rows, setSelection],
  );

  const selectUntranslated = useCallback(() => {
    setSelection(new Set(rows.filter((r) => !r.translated).map((r) => r.id)));
  }, [rows, setSelection]);

  const selectLabel = useCallback(
    (id: string) => {
      setSelection((prev) => {
        const next = new Set(prev);
        for (const r of rows) if (r.label === id) next.add(r.id);
        return next;
      });
    },
    [rows, setSelection],
  );

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
    <section class="review">
      <div class="rv-toolbar">
        <div class="row">
          <select
            value={store.reviewKey ?? ""}
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
            <button onClick={selectUntranslated} disabled={!artifact.incomplete?.length}>
              Select untranslated
            </button>
            <button onClick={() => setSelection(new Set())} disabled={!selection.size}>
              Clear
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
                  changed={false}
                  onToggle={toggle}
                />
              </Fragment>
            ))}
            {!shown.length ? <p class="empty">No lines match.</p> : null}
          </div>

          <ReviewBar
            artifact={artifact}
            retry={retry}
            busy={busy}
            selectedIds={selectedIds}
            preset={presetId}
            onPreset={setPresetId}
            hint={hint}
            onHint={setHint}
            estimate={estimate}
          />
        </>
      )}
    </section>
  );
}

function ReviewBar({
  artifact,
  retry,
  busy,
  selectedIds,
  preset,
  onPreset,
  hint,
  onHint,
  estimate,
}: {
  artifact: Artifact;
  retry: ReturnType<typeof useRetranslate>;
  busy: boolean;
  selectedIds: string[];
  preset: string;
  onPreset: (id: string) => void;
  hint: string;
  onHint: (s: string) => void;
  estimate: ReturnType<ReturnType<typeof useRetranslate>["estimate"]>;
}) {
  const store = useStore();
  const s = retry.state;
  const chosen = store.settings.presets.find((p) => p.id === preset) ?? store.activePreset();

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
            onClick={() => void retry.apply(artifact, kept)}
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

  const used = store.settings.limiter[chosen.id]?.dayRequests ?? 0;
  const left = chosen.limits.rpd ? chosen.limits.rpd - used : 0;

  return (
    <div class="rv-bar">
      <div class="row">
        <span class="count">
          {selectedIds.length} line{selectedIds.length === 1 ? "" : "s"} selected
        </span>
        {estimate ? (
          <span class="est">
            {estimate.calls} call{estimate.calls === 1 ? "" : "s"} · ~
            {estimate.inputTokens.toLocaleString()} in / ~{estimate.outputTokens.toLocaleString()} out
            {" · "}
            {estimate.contextLines} context line{estimate.contextLines === 1 ? "" : "s"}
            {chosen.limits.rpd ? ` · ${left} of ${chosen.limits.rpd} requests left today` : ""}
          </span>
        ) : null}
      </div>
      <div class="row">
        <select value={preset} onChange={(e) => onPreset((e.target as HTMLSelectElement).value)}>
          {store.settings.presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <input
          class="rv-hint"
          placeholder='Optional note for these lines (e.g. "テンジン is a character name — keep it")'
          value={hint}
          onInput={(e) => onHint((e.target as HTMLInputElement).value)}
        />
        <button
          disabled={busy}
          title={busy ? "A translation is already running." : ""}
          onClick={() => void retry.start(artifact, selectedIds, chosen, hint)}
        >
          Retranslate {selectedIds.length}
        </button>
      </div>
      <p class="hint">Nearby lines are sent as context but are not changed.</p>
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
    const key = `${a.book}::${a.lang}`;
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
