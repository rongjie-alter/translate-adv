/**
 * One line of the Review reader, and the structure rows between lines.
 *
 * Both are memoized and take only scalars, so toggling a single selection
 * re-renders one row rather than the whole chapter. The rendered HTML is
 * precomputed by the parent for the same reason — `renderCompact` is four regex
 * passes, and running it per render for a couple of thousand units on every
 * keystroke in the find box is the one thing that would actually be slow.
 */
import { memo } from "preact/compat";
import type { ArtifactMarker } from "../storage/exchange";

export interface Row {
  /** Index into `artifact.units` — the coordinate a shift-click range works in. */
  index: number;
  id: string;
  kind: "text" | "select" | "title";
  /** Precomputed display HTML. */
  srcHtml: string;
  tlHtml: string;
  charaTl: string;
  charaJp: string;
  to?: string;
  /** Nearest preceding label id, for "select every line under this label". */
  label: string | null;
  /** Lowercased source + translation, for the find box. */
  haystack: string;
  translated: boolean;
  markersBefore: ArtifactMarker[];
  depth: number;
}

export const ReviewUnit = memo(function ReviewUnit({
  row,
  selected,
  focused,
  changed,
  onToggle,
}: {
  row: Row;
  selected: boolean;
  focused: boolean;
  changed: boolean;
  onToggle: (index: number, shift: boolean) => void;
}) {
  const classes = ["rv-unit", row.kind];
  if (selected) classes.push("sel");
  if (focused) classes.push("focus");
  if (changed) classes.push("changed");
  if (!row.translated) classes.push("gap");

  return (
    <div
      class={classes.join(" ")}
      role="option"
      aria-selected={selected}
      style={{ "--depth": row.depth }}
      onClick={(e) => onToggle(row.index, e.shiftKey)}
    >
      {/* Decorative: the row owns the click, so a live checkbox would toggle twice. */}
      <input type="checkbox" checked={selected} readOnly tabIndex={-1} />
      <div class="rv-text">
        <div class="rv-tl">
          {row.charaTl ? <span class="rv-chara">{row.charaTl}</span> : null}
          {row.kind === "select" ? <span class="rv-opt">▸</span> : null}
          {row.translated ? (
            <span dangerouslySetInnerHTML={{ __html: row.tlHtml }} />
          ) : (
            <span class="rv-none">[not translated]</span>
          )}
          {row.to ? <span class="rv-to">→ {row.to}</span> : null}
        </div>
        <div class="rv-jp">
          {row.charaJp ? <span class="rv-chara">{row.charaJp}</span> : null}
          <span dangerouslySetInnerHTML={{ __html: row.srcHtml }} />
        </div>
      </div>
    </div>
  );
});

export const ReviewMarker = memo(function ReviewMarker({
  marker,
  depth,
  count,
  onSelectLabel,
}: {
  marker: ArtifactMarker;
  depth: number;
  /** Lines under this label, when it is one. */
  count?: number;
  onSelectLabel?: (id: string) => void;
}) {
  const style = { "--depth": depth };
  switch (marker.kind) {
    case "label":
      return (
        <div class="rv-marker label" style={style} id={`rv-${marker.id}`}>
          <span>Label: {marker.id}</span>
          {count && onSelectLabel ? (
            <button class="link" onClick={() => onSelectLabel(marker.id!)}>
              select {count} line{count === 1 ? "" : "s"}
            </button>
          ) : null}
        </div>
      );
    case "jump":
      return (
        <div class="rv-marker jump" style={style}>
          {marker.random ? "50% chance of jumping to " : "Jump to "}
          <a href={`#rv-${marker.to}`}>{marker.to}</a>
        </div>
      );
    case "cond":
      return (
        <div class="rv-marker cond" style={style}>
          If {marker.expr}
        </div>
      );
    default:
      return (
        <div class="rv-marker cond" style={style}>
          end if
        </div>
      );
  }
});
