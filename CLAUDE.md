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

Structure is sent as context but never echoed back; that roughly halves output tokens, which are
the binding constraint on the free tiers this targets. Labels are shortened to short aliases
(`labels.ts`) before sending, because `quest_evMain_touroumatsuri2026_0_a_alt1` is pure cost.

### The parse.py ↔ scraper contract

`parse.py --tl_meta` (on by default; `--no_tl_meta` restores the pre-existing output byte-for-byte)
writes `data-*` attributes onto the elements it was already emitting: `data-chara`, `data-pose`,
`data-chara-{en,zh-hans,zh-hant}` resolved through `Character.xls → NameText → Localize.xls`, plus
`data-to`/`data-if`/`data-do` on selections and jumps, `data-param` on `<code>`, and
`data-parse-version` on `<body>`.

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

## Untested surfaces

The live Gemini endpoint has never been exercised (no key) — model id and free-tier limits in
`presets.ts` are best-effort and user-editable. `showDirectoryPicker` needs an OS dialog, so only
the folder logic behind it is covered (`fsa.test.ts` uses a stub handle); the operations take a
`DirectoryHandle` explicitly for exactly that reason.
