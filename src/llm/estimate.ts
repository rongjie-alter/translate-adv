/**
 * Token estimation.
 *
 * Latin text runs about 4 characters per token; Japanese runs about 1, because
 * kanji and kana mostly get their own token. A naive `length / 4` therefore
 * under-counts a Japanese chapter by ~4x and would make the pre-flight estimate
 * worse than useless. We count the two scripts separately and calibrate the
 * Japanese factor against real `usage` numbers as soon as the first call returns.
 */
import type { Lang } from "../scenario/model";

/** CJK ideographs, kana, and full-width punctuation — one token each, roughly. */
const CJK = /[⺀-鿿豈-﫿＀-｠　-〿]/;

export function countScripts(text: string): { cjk: number; other: number } {
  let cjk = 0;
  for (const ch of text) if (CJK.test(ch)) cjk++;
  return { cjk, other: text.length - cjk };
}

/**
 * @param charsPerToken Japanese characters per token for the target tokenizer.
 */
export function estimateTokens(text: string, charsPerToken: number): number {
  const { cjk, other } = countScripts(text);
  return Math.ceil(cjk / Math.max(0.2, charsPerToken) + other / 4);
}

/** Expected output tokens per input token of *source text*, per target language. */
export const OUTPUT_RATIO: Record<Lang, number> = {
  en: 0.9,
  "zh-hans": 0.8,
  "zh-hant": 0.8,
};

export interface Calibration {
  charsPerToken: number;
  outputRatio: number;
  samples: number;
}

/**
 * Fold one real `usage` report into the running calibration.
 *
 * Solves `tokens = cjk / cpt + other / 4` for `cpt`, then blends with an
 * exponential moving average so a single odd response cannot swing the estimate.
 *
 * Output cost is derived as `totalTokens - promptTokens`, not the API's
 * `completion_tokens`, because reasoning models (Gemini 3, o-series) spend most of
 * `maxOutputTokens` on hidden "thinking" tokens that never appear in
 * `completion_tokens` but still count against the cap — calibrating on
 * `completion_tokens` alone would read that spend as near-zero and let the chunker
 * keep building chunks the model can never finish. For a non-reasoning model
 * `totalTokens` is just `promptTokens + completionTokens`, so this is a superset of
 * the old signal, never a worse one.
 */
export function calibrate(
  prev: Calibration,
  sample: {
    promptText: string;
    promptTokens: number;
    sourceTokens: number;
    totalTokens: number;
  },
): Calibration {
  const next = { ...prev, samples: prev.samples + 1 };
  const weight = 1 / Math.min(next.samples, 8); // fast at first, then steady

  const { cjk, other } = countScripts(sample.promptText);
  const cjkTokens = sample.promptTokens - other / 4;
  if (cjk > 0 && cjkTokens > 0) {
    const observed = cjk / cjkTokens;
    next.charsPerToken = prev.charsPerToken * (1 - weight) + observed * weight;
  }

  const outputTokens = sample.totalTokens - sample.promptTokens;
  if (sample.sourceTokens > 0 && outputTokens > 0) {
    const observed = outputTokens / sample.sourceTokens;
    next.outputRatio = prev.outputRatio * (1 - weight) + observed * weight;
  }

  return next;
}

export interface JobEstimate {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Wall-clock lower bound implied by the requests-per-minute limit, in seconds. */
  minSeconds: number;
  /** True when the job cannot finish today under the requests-per-day limit. */
  exceedsDaily: boolean;
}

export function estimateJob(args: {
  chunkTexts: string[];
  systemPrompt: string;
  charsPerToken: number;
  outputRatio: number;
  rpm: number;
  rpd: number;
  requestsUsedToday: number;
}): JobEstimate {
  const system = estimateTokens(args.systemPrompt, args.charsPerToken);
  let inputTokens = 0;
  let outputTokens = 0;
  for (const text of args.chunkTexts) {
    const body = estimateTokens(text, args.charsPerToken);
    inputTokens += system + body;
    outputTokens += Math.ceil(body * args.outputRatio);
  }
  const calls = args.chunkTexts.length;
  return {
    calls,
    inputTokens,
    outputTokens,
    minSeconds: args.rpm > 0 ? Math.max(0, ((calls - 1) / args.rpm) * 60) : 0,
    exceedsDaily: args.rpd > 0 && args.requestsUsedToday + calls > args.rpd,
  };
}
