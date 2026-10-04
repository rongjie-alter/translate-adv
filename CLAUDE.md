# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install
pnpm dev                 # Vite dev server
pnpm test                # vitest run
pnpm build               # tsc --noEmit && vite build
```

Single test file or single case:

```bash
pnpm exec vitest run src/orchestrator/orchestrator.test.ts
```

```bash
pnpm exec vitest run -t "repairs lines the model dropped"
```

Typecheck alone: `pnpm exec tsc --noEmit`. Use `pnpm exec`, not `npx` — `devEngines.packageManager`
pins pnpm and npx aborts with `EBADDEVENGINES`.

Python is invoked as `py`, not `python3`:

```bash
py parse.py book/touroumatsuri2026.book.json
```

```bash
py mock_server.py --port 8787 --latency-ms 300 --rpm 6 --drop-rate 0.05 --fail-rate 0.1
```

The mock server is the way to exercise the orchestrator without spending real quota; its flags
inject rate limits, transient 5xx, dropped lines and truncated responses. Select **Local mock
server (testing)** in the app's Settings to point at it.

## Architecture

A client-only browser app (Preact + Vite, no backend) that translates Japanese ADV scenario books
through any OpenAI-compatible endpoint. `mock_server.py` exists only for testing.

The pipeline, and where each stage lives:

```
.book.json ──parse.py──> .book.html ──parseHtml.ts──> Book/Chapter/SceneNode
   └─ common.chapter.json (official names)                    │
                                                        chunker.ts
                                                              │
                              serialize.ts ──wire text──> runner.ts ──> endpoint
                                                              │
                                    units (IndexedDB) ──> exchange.ts (.tl.json)
                                                              │
                                                        bilingual.ts ──> combined HTML
```

### The wire-format contract (four files must agree)

`serialize.ts` emits `<id> [speaker: ]text` lines with structure as unnumbered context
(`== label ==`, `=> jump`, `? cond`, `~ carried-over context`). `prompt.ts` documents that format
to the model and demands `<id> <text>` back with nothing else. `parseResponse` in `serialize.ts`
parses the reply. `mock_server.py` mimics it. **Changing the format means changing all four**, and
the format rules in `DEFAULT_SYSTEM_PROMPT` are load-bearing — the Settings screen lets users edit
that prompt, which is why it warns them.

Models echo the `>alias` of a branch option and the `Name：` of a speaker back however the prompt
is worded, and every stored echo is replayed as `~` context, teaching the next chunk to do it
too. So the prompt does **not** forbid either; `scenario/cleanup.ts` strips them mechanically —
per line in `parseResponse` (where the real alias and the speaker's names are on the `WireLine`),
and over a whole artifact by `cleanUnits`, which the **Clean up** button in `ReviewView` runs to
repair older files. It is a button, not an import step, because it rewrites translations — the
user opts in. It saves through `putUnits(..., { keepPrevious: true })` so the lines can be
reverted. It must stay idempotent, since it can be run repeatedly. A prefix is removed
only if it matches a name the speaker is known by, is a prefix learned from a majority of that
speaker's own lines, or (parse time only) looks like a bare name. Match each colon in turn: a
speaker name can itself contain one (`SYSTEM：DEUS`), and CJK output uses `：` with no space after.

Structure is sent as context but never echoed back; that roughly halves output tokens, which are
the binding constraint on the free tiers this targets. Labels are shortened to short aliases
(`labels.ts`) before sending, because `quest_evMain_touroumatsuri2026_0_a_alt1` is pure cost.

### The glossary: text-driven, not speaker-driven

`scenario/glossary.ts` decides which names and terms the system prompt's `{{glossary}}` carries
for a chapter. A name is sent if its speaker label appears in the chapter **or its Japanese
appears in the chapter's text** (longest match first, katakana-only keys must not sit inside a
longer katakana word). Candidates, merged by Japanese key: every speaker in the *book* (not just
the chapter), `Book.terms` from `parse.py`'s `#term-meta`, the Dictionary + per-file
`customNames`, and an artifact's recorded `glossary`. Precedence: a speaker's parser name, then
the user's entry, then the game tables.

Two filters keep the prompt small, because every line is input tokens on every chunk and the
model already handles most generic words. `isValuableTerm` drops `？？？？`, `（観客）`,
`…？` unknown-speaker labels, collectives (`〜たち`, `３人`, `全員`) and 1–3 character pure-kanji
nouns (`少年`); **user-typed entries bypass it**. And `GLOSSARY_LIMIT` caps the list, speakers
first then by frequency. `parse.py` mirrors `isValuableTerm` (`isValuableTerm()` there) so
`#term-meta` only lists Localize rows that pass it *and* occur in the book — ~30 rows for
`main23`, not the 1015-row table. Keep the two copies in step.

`assembleSystemPrompt` is the single place the prompt is built (template + glossary + file note);
`runner.ts`, `retranslate.ts`, `useTranslation.ts`, `useRetranslate.ts` and the Scan estimate all
go through it. `Artifact.glossary` records what was sent so a `.tl.json` with no `.book.html`
retranslates with the same terms; `SourceRecord.excludedTerms` is the per-file off switch the
Scan screen's glossary panel writes. Nothing on the wire changed.

### Retranslating selected lines

`retranslate.ts` redoes a hand-picked set of units without redoing the chapter. It is driven by
the **`Artifact`, not the `Chapter`** — an artifact carries `src`, `speaker`, `kind`, `to` and the
structure markers, so a retry works on an imported `.tl.json` with no `.book.html` loaded
(`artifactNodes`/`artifactLabelIds`/`artifactSpeakers` in `exchange.ts` rebuild what the wire needs).
This is only possible because `jobId(book, chapter, lang)` and `artifactKey(...)` produce the
identical string, so unit rows land in the right place either way.

Selected lines are grouped, nearby groups merge, and each group is sent with its neighbours as `~`
context — the *existing translation* where there is one, falling back to the Japanese. Context
costs input tokens and produces no output, so `planRetranslate` weighs `maxInputTokens` and
`maxOutputTokens` **separately** via `budgetParts` rather than the chunker's single `chunkBudget`;
a naive combined budget splits requests that would comfortably have fit. Non-consecutive groups are
separated by `~ [...]`.

**None of this adds a wire token** — `~` is already documented as "not content" in the prompt and
already skipped by `parseResponse` and `mock_server.py`, so the four-file contract is untouched.
`RETRANSLATE_INSTRUCTION` and the user's per-retry note are appended at send time the way
`REPAIR_INSTRUCTION` is, deliberately *not* added to `DEFAULT_SYSTEM_PROMPT`, because that template
is user-editable and `loadSettings` never migrates a stored copy forward.

`runRetranslate` returns proposals and writes nothing; `ReviewView` shows old vs new and the user
keeps or discards each line, because a different model can easily come back worse. Accepted lines
go through `db.putUnits(..., { keepPrevious: true })` (one level of history on `UnitRecord.prev`,
enough for `revertUnits`) and `applyTranslations`, which patches the artifact in place instead of
calling `buildArtifact` — the latter needs the source `Chapter`, which may not exist. Per-line
provenance lives on `units[].model`, set only when it differs from the chapter's; `Artifact.model`
is deliberately left naming the model that did the bulk.

`send.ts` holds the quota/retry/repair machinery both runners share. Keep it that way — the
`check() → reserve() → call → settle()` order is test-enforced, and a retry must reserve against
the **chosen** preset's limiter slot, not the active one, or it silently spends another endpoint's
free-tier quota.

### The parse.py ↔ scraper contract

`parse.py --tl_meta` (on by default; `--no_tl_meta` restores the pre-existing output byte-for-byte)
writes `data-*` attributes onto the elements it was already emitting: `data-chara`, `data-pose`,
`data-chara-{en,zh-hans,zh-hant}` resolved through `Character.xls → NameText → Localize.xls`, plus
`data-to`/`data-if`/`data-do` on selections and jumps, `data-param` on `<code>`, and
`data-parse-version` on `<body>`. It also embeds `<script id="term-meta">` — see the
glossary section; older files lack it and simply send fewer terms.

`parseHtml.ts` prefers those attributes and falls back to the visible text when absent, so files
generated before this existed still work — just without official names. Keep that fallback intact;
a test strips every `data-*` attribute and asserts identical unit counts.

Two structural facts about the HTML: `parse.py` writes one element per line as a flat sibling under
`<body>`, **except** `div.cond-block`, which is opened at `If` and closed at `EndIf` so the HTML
parser nests everything between them. That is why the scraper walks the tree recursively rather
than the lines. Chapters are delimited only by `<h3 id>`.

### Inline markup round-trip

`inline.ts` holds two near-inverses: `toCompact` (DOM → `平(たいら)`, `{playerName}`, `*em*`,
`^big^`, `<br>` dropped) and `renderCompact` (back to display HTML). `renderCompact` takes
`ruby: false` for the translated side — a translation has no kanji base to hang a reading on.
`<size=N>` pixel values do not survive in the text, so they ride alongside as `sizes: number[]`.

### Resume, and what "done" means

Progress is written to IndexedDB after every chunk. On restart, `reconcileJob` in
`useTranslation.ts` re-chunks from scratch and marks a chunk done **iff every unit id in it already
has a stored translation** — not by trusting the previous chunk boundaries, which move whenever the
model, prompt or chunk-size setting changes. Unit ids are `{label}/{n}`, scoped to the nearest
preceding `div.label`.

### Quota

`limiter.ts` gates every request; `runner.ts` never calls the endpoint without `reserve()` first.
On a free tier a throttled request is quota burned for nothing, so the app self-limits rather than
discovering limits via 429s. Counters persist across reloads and roll over on the endpoint's own
timezone. `runner.ts` depends on the `Quota` interface, not the `RateLimiter` class, so tests can
substitute a stub instead of manipulating clocks.

An exhausted daily quota is treated as fatal for the run (`isFatal`) — it would fail every
remaining chunk identically, so stopping preserves the quota for a later working run.

### Artifacts are self-contained

A `.tl.json` (`exchange.ts`) carries its own source text and branch markers, so `bilingual.ts` can
combine files from other people with neither the original `.book.html` nor an API key. That is the
whole point of the sharing model. Merge resolves duplicates by completeness then recency, and flags
a `srcHash` mismatch rather than silently merging two versions of the book.

### Token estimation

Japanese runs ~1 character per token against English's ~4, so `estimate.ts` counts scripts
separately and calibrates `charsPerToken` from real `usage` values after the first call. Estimates
before any calibration are rough by design; the Scan screen says so.

## Testing notes

Tests read the real `book/*.book.html` fixtures relative to the repo root — run vitest from there.
Regenerating those files can change chapter counts and break assertions (they went from 3 to 7
chapters once already).

Neither sample book exercises `div.cond-block`, `div.title` or `span.voice` — `parse.py` only emits
cond-blocks for conditions containing `team`/`player`. Those paths need synthetic fixtures; see the
conditional-block test in `bilingual.test.ts`.

`vite.config.ts` imports `defineConfig` from `vitest/config`, not `vite`, so the `test` key
typechecks.
