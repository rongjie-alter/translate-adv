/**
 * Mass-correct a recurring translation mistake across a whole chapter.
 *
 * Lives entirely inside one modal: type find/replace, optionally narrow to a
 * speaker, uncheck any line that shouldn't change, then commit. Writes go
 * through the same db.putUnits + applyTranslations path as a manual edit, so
 * every replaced line gets the same revert (↺) affordance for free.
 */
import { useEffect, useMemo, useState } from "preact/hooks";
import { renderCompact } from "../scenario/inline";
import { speakerName } from "../scenario/serialize";
import * as db from "../storage/db";
import { applyTranslations, artifactKey, artifactSpeakers, type Artifact } from "../storage/exchange";
import type { Row } from "./ReviewUnit";
import { useStore } from "./store";

interface Match {
  uid: string;
  charaTl: string;
  before: string;
  after: string;
}

export function FindReplacePanel({
  artifact,
  rows,
  onApplied,
  onClose,
}: {
  artifact: Artifact;
  rows: Row[];
  onApplied: (uids: string[]) => void;
  onClose: () => void;
}) {
  const store = useStore();
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [speakerJp, setSpeakerJp] = useState("");
  const [keeps, setKeeps] = useState<ReadonlySet<string>>(new Set());
  const [applying, setApplying] = useState(false);

  const speakers = useMemo(() => artifactSpeakers(artifact), [artifact]);

  const matches = useMemo<Match[]>(() => {
    const needle = find.trim();
    if (!needle) return [];
    const haystack = matchCase ? (s: string) => s : (s: string) => s.toLowerCase();
    const needleForSearch = haystack(needle);
    return rows
      .filter((r) => haystack(r.tl).includes(needleForSearch))
      .filter((r) => !speakerJp || r.charaJp === speakerJp)
      .map((r) => ({
        uid: r.id,
        charaTl: r.charaTl,
        before: r.tl,
        after: replaceAll(r.tl, needle, replace, matchCase),
      }));
  }, [rows, find, replace, matchCase, speakerJp]);

  // Every new match starts checked; a match that disappears (edited find/filter) drops out on its own.
  useEffect(() => {
    setKeeps(new Set(matches.map((m) => m.uid)));
  }, [find, replace, matchCase, speakerJp]);

  const keptCount = matches.filter((m) => keeps.has(m.uid)).length;

  const toggle = (uid: string) => {
    setKeeps((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  };

  const apply = async () => {
    const texts = new Map(matches.filter((m) => keeps.has(m.uid)).map((m) => [m.uid, m.after]));
    if (!texts.size) return;
    setApplying(true);
    try {
      const at = Date.now();
      const key = artifactKey(artifact);
      await db.putUnits(key, texts, { keepPrevious: true, model: "find-replace", at });
      await store.saveArtifact(applyTranslations(artifact, texts, { model: "find-replace", at }));
      onApplied([...texts.keys()]);
      store.toast(`${texts.size} line${texts.size === 1 ? "" : "s"} replaced.`);
      onClose();
    } finally {
      setApplying(false);
    }
  };

  return (
    <>
      <div class="help-dialog-header">
        <h2>Find & Replace</h2>
        <button class="help-dialog-close" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </div>

      <div class="row">
        <input
          class="rv-find"
          placeholder="Find…"
          value={find}
          onInput={(e) => setFind((e.target as HTMLInputElement).value)}
          autoFocus
        />
        <input
          class="rv-find"
          placeholder="Replace with…"
          value={replace}
          onInput={(e) => setReplace((e.target as HTMLInputElement).value)}
        />
      </div>
      <div class="row">
        <label class="rv-check">
          <input
            type="checkbox"
            checked={matchCase}
            onChange={(e) => setMatchCase((e.target as HTMLInputElement).checked)}
          />{" "}
          Match case
        </label>
        <select value={speakerJp} onChange={(e) => setSpeakerJp((e.target as HTMLSelectElement).value)}>
          <option value="">All speakers</option>
          {speakers.map((s) => (
            <option key={s.jp} value={s.jp}>
              {speakerName(s, artifact.lang)}
            </option>
          ))}
        </select>
      </div>

      {!find.trim() ? (
        <p class="hint">Type text to find.</p>
      ) : !matches.length ? (
        <p class="empty">No lines match.</p>
      ) : (
        <>
          <p class="hint">
            {matches.length} line{matches.length === 1 ? "" : "s"} match{matches.length === 1 ? "es" : ""}
            {" · "}
            {keptCount} selected
          </p>
          <div class="rv-props">
            {matches.map((m) => (
              <MatchRow key={m.uid} m={m} kept={keeps.has(m.uid)} onToggle={() => toggle(m.uid)} />
            ))}
          </div>
        </>
      )}

      <div class="row help-dialog-footer">
        <button onClick={() => setKeeps(new Set(matches.map((m) => m.uid)))} disabled={!matches.length}>
          Select all
        </button>
        <button onClick={() => setKeeps(new Set())} disabled={!matches.length}>
          Deselect all
        </button>
        <span class="spacer" />
        <button onClick={onClose}>Cancel</button>
        <button class="primary" disabled={!keptCount || applying} onClick={() => void apply()}>
          Replace {keptCount || ""}
        </button>
      </div>
    </>
  );
}

function MatchRow({ m, kept, onToggle }: { m: Match; kept: boolean; onToggle: () => void }) {
  return (
    <div class={`rv-prop${kept ? " keep" : ""}`}>
      <input type="checkbox" checked={kept} onChange={onToggle} />
      <div>
        {m.charaTl ? <span class="rv-chara">{m.charaTl}</span> : null}
        <div class="rv-was" dangerouslySetInnerHTML={{ __html: renderCompact(m.before, { ruby: false }) }} />
        <div class="rv-new" dangerouslySetInnerHTML={{ __html: renderCompact(m.after, { ruby: false }) }} />
      </div>
    </div>
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceAll(text: string, find: string, replace: string, matchCase: boolean): string {
  if (matchCase) return text.split(find).join(replace);
  return text.replace(new RegExp(escapeRegExp(find), "gi"), replace);
}
