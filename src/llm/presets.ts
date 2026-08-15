/**
 * Endpoint/model presets and their quota shapes.
 *
 * Free-tier numbers change without notice, so everything here is editable in
 * Settings — these are only the starting values. Anything OpenAI-compatible works:
 * the app only ever calls `POST {baseUrl}/chat/completions`.
 */

export interface Limits {
  /** Requests per minute. 0 = unlimited. */
  rpm: number;
  /** Requests per day. 0 = unlimited. */
  rpd: number;
  /** Input tokens per minute. 0 = unlimited. */
  tpm: number;
  /** Context window the app is willing to fill with one chunk. */
  maxInputTokens: number;
  /** Hard cap on a single response. */
  maxOutputTokens: number;
}

export interface Preset {
  id: string;
  label: string;
  /** Base URL including the version segment, e.g. `.../v1beta/openai`. */
  baseUrl: string;
  model: string;
  limits: Limits;
  /**
   * Japanese characters per token for this tokenizer. Gemini and GPT-family models
   * sit near 1 for kanji/kana — far denser than the ~4 chars/token of English — and
   * getting this wrong makes every estimate useless. Calibrated from real usage
   * after the first call.
   */
  charsPerToken: number;
  /** IANA zone whose midnight resets the daily quota. */
  quotaResetTz: string;
  /** Where to get a key; shown in Settings. */
  keyUrl?: string;
  builtin?: boolean;
}

export const PRESETS: Preset[] = [
  {
    id: "gemini-flash",
    label: "Gemini Flash (Google AI Studio free tier)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-flash-latest",
    limits: { rpm: 5, rpd: 20, tpm: 250_000, maxInputTokens: 32_000, maxOutputTokens: 8_192 },
    charsPerToken: 1.0,
    quotaResetTz: "America/Los_Angeles",
    keyUrl: "https://aistudio.google.com/api-keys",
    builtin: true,
  },
  {
    id: "gemini-flash-lite",
    label: "Gemini Flash Lite (Google AI Studio free tier)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-flash-lite-latest",
    limits: { rpm: 15, rpd: 500, tpm: 250_000, maxInputTokens: 32_000, maxOutputTokens: 8_192 },
    charsPerToken: 1.0,
    quotaResetTz: "America/Los_Angeles",
    keyUrl: "https://aistudio.google.com/api-keys",
    builtin: true,
  },
  {
    id: "gemma4-31b",
    label: "Gemma4 31B (Google AI Studio free tier)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemma-4-31b-it",
    limits: { rpm: 30, rpd: 14400, tpm: 16_000, maxInputTokens: 16_000, maxOutputTokens: 8_192 },
    charsPerToken: 1.0,
    quotaResetTz: "America/Los_Angeles",
    keyUrl: "https://aistudio.google.com/api-keys",
    builtin: true,
  },
  {
    id: "mock",
    label: "Local mock server (testing)",
    baseUrl: "http://localhost:8787/v1",
    model: "mock-translate-1",
    limits: { rpm: 0, rpd: 0, tpm: 0, maxInputTokens: 8_000, maxOutputTokens: 8_000 },
    charsPerToken: 1.0,
    quotaResetTz: "UTC",
    builtin: true,
  },
];

export const DEFAULT_PRESET_ID = "gemini-flash";

export function findPreset(presets: Preset[], id: string): Preset {
  return presets.find((p) => p.id === id) ?? presets[0];
}
