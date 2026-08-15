# translate-adv

Browser app for translating Utage/ADV scenario books with any OpenAI-compatible endpoint.

Input is a `.book.html` produced by `parse.py`. You pick one chapter at a time, the app
chunks it, calls the endpoint under the endpoint's own rate limits, and saves progress after
every chunk. Finished chapters are exchangeable `.tl.json` files, so several people can split
the cost of a free tier and merge the results into one bilingual file afterwards.

Everything runs in the browser. There is no backend and no server to trust with an API key —
keys stay in IndexedDB and go only to the endpoint you configured.

## Quick start

```bash
pnpm install
```

```bash
pnpm dev
```

Open the app, go to **Settings**, pick an endpoint and paste an API key
([Google AI Studio](https://aistudio.google.com/api-keys) has a usable free tier), then drag a
`.book.html` onto the page.

## Producing input files

```bash
py parse.py book/touroumatsuri2026.book.json
```

`parse.py` now writes `data-*` attributes the app reads: official character names per language
(resolved through `Character.xls` → `Localize.xls` in `common.chapter.json`), branch targets,
selection conditions, and `<param=…>` names. They are additive, so the HTML still renders and
reads exactly as before; `--no_tl_meta` restores the old output byte-for-byte.

The app also works on files generated before this change — it falls back to the visible text,
just without official names.

## Testing without spending quota

```bash
py mock_server.py --port 8787 --latency-ms 300 --rpm 6 --drop-rate 0.05 --fail-rate 0.1
```

A stdlib-only OpenAI-compatible stub that echoes each line back. The flags inject the failure
modes that are hard to provoke deliberately against a real endpoint: rate limits with
`Retry-After`, transient 5xx, dropped lines (exercises the repair pass), and truncated
responses. Select **Local mock server (testing)** in Settings to point at it.

```bash
pnpm test
```

## How it fits together

| Path | Role |
| --- | --- |
| `src/scenario/` | Scrape `.book.html` into a model; compact inline markup; the LLM wire format |
| `src/llm/` | Chat client, endpoint presets, quota limiter, token estimation, system prompt |
| `src/orchestrator/` | Chunking and the job runner |
| `src/storage/` | IndexedDB, the `.tl.json` exchange format, optional folder sync |
| `src/combine/` | Bilingual HTML output |
| `src/ui/` | Scan / Translate / Review / Library / Settings |

A few decisions worth knowing about:

- **Structure is context, not content.** Labels, jumps and conditions are sent so the model can
  tell a branch option from narration, but it is asked to return only `<id> <text>`. Labels are
  shortened to short aliases first, since `quest_evMain_touroumatsuri2026_0_a_alt1` is pure cost.
- **Japanese tokenizes about four times denser than English.** Estimates count scripts separately
  and calibrate against real `usage` numbers after the first call, so the pre-flight "N calls,
  ~X tokens" figure is trustworthy by the second chunk.
- **Quota is enforced client-side.** On a free tier a throttled request is quota burned for
  nothing, so nothing is sent unless the limiter says there is room. Counters persist across
  reloads and roll over on the endpoint's own timezone.
- **Progress is written per chunk**, and a chunk counts as done when every line in it has a
  stored translation — so changing the model or chunk size mid-chapter still resumes correctly
  instead of re-paying for work already done.
- **Exchange files are self-contained.** A `.tl.json` carries its own source text and branch
  structure, so whoever assembles the final file needs neither the original book nor a key.
- **Bad lines can be redone one at a time.** **Review** shows a chapter as Japanese/translation
  pairs; tick the lines that came out wrong and retranslate only those, optionally with a different
  model and a note ("this is a character name — keep it"). Neighbouring lines ride along as context
  so the model can see what it misread, and scattered lines are packed into as few calls as the
  token budget allows. Results are shown old-vs-new and applied per line. Because it reads the
  `.tl.json` rather than the book, it also works on a chapter someone else translated.

## Sharing the cost

Each person translates some chapters and exports the `.tl.json` files; anyone can drop the
collected files onto the app and hit **Combine**. Duplicates resolve to the more complete
translation, and translations made from a different version of the book are flagged rather
than silently merged.

On Chrome or Edge you can instead point the app at a shared folder (**Library → Use a folder**).
Finished chapters are written there automatically and picked up on the next scan.
