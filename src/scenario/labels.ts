/**
 * Label shortening.
 *
 * Scenario labels are long and highly repetitive — every branch in a chapter shares
 * a prefix like `quest_evMain_touroumatsuri2026_0_`. Sending them verbatim costs
 * real tokens for zero information, so each chunk uses short aliases and expands
 * them again locally.
 */

export interface LabelMap {
  alias(id: string): string;
  expand(alias: string): string | undefined;
  readonly size: number;
}

const MAX_ALIAS = 14;

export function makeLabelMap(ids: string[]): LabelMap {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  const prefix = commonUnderscorePrefix(unique);

  const toAlias = new Map<string, string>();
  const fromAlias = new Map<string, string>();

  unique.forEach((id, i) => {
    let a = id.slice(prefix.length);
    if (!a || a.length > MAX_ALIAS || fromAlias.has(a)) a = `L${i}`;
    toAlias.set(id, a);
    fromAlias.set(a, id);
  });

  return {
    alias: (id) => toAlias.get(id) ?? id,
    expand: (alias) => fromAlias.get(alias),
    size: unique.length,
  };
}

/** Longest common prefix of all ids, trimmed back to an underscore boundary. */
function commonUnderscorePrefix(ids: string[]): string {
  if (ids.length < 2) return "";
  let end = ids[0].length;
  for (const id of ids.slice(1)) {
    let i = 0;
    while (i < end && i < id.length && id[i] === ids[0][i]) i++;
    end = i;
    if (end === 0) return "";
  }
  const cut = ids[0].lastIndexOf("_", end - 1);
  return cut < 0 ? "" : ids[0].slice(0, cut + 1);
}
