/**
 * One request to the endpoint, with quota, retry/backoff and the repair round.
 *
 * Split out of `runner.ts` so the targeted-retranslation path in `retranslate.ts`
 * cannot drift from it. The discipline here is the point: nothing is sent unless
 * the limiter says there is room, because on a free tier a throttled request is
 * quota burned for nothing.
 */
import { backoffMs, chat, LlmError, sleep, type ChatResponse } from "../llm/client";
import { estimateTokens } from "../llm/estimate";
import type { Quota } from "../llm/limiter";
import { REPAIR_INSTRUCTION } from "../llm/prompt";
import {
  parseResponse,
  serializeRepair,
  type WireChunk,
  type WireLine,
} from "../scenario/serialize";

const MAX_ATTEMPTS = 4;
const MAX_REPAIRS = 2;

/** Events both runners emit. Structurally a subset of `RunEvent`. */
export type SendEvent =
  | { type: "waiting"; ms: number; reason: string }
  | { type: "retry"; index: number; attempt: number; error: string }
  | { type: "repair"; index: number; missing: number }
  | { type: "log"; message: string };

export interface SendDeps {
  limiter: Quota;
  apiKey: string;
  baseUrl: string;
  model: string;
  maxOutputTokens: number;
  onEvent(e: SendEvent): void;
  /** Injectable for tests. */
  chat?: typeof chat;
}

export function isFatal(e: unknown): boolean {
  return e instanceof LlmError && !e.retryable;
}

/** One request, with quota waiting and retry/backoff around it. */
export async function sendRequest(args: {
  system: string;
  user: string;
  estimate: number;
  /** Only used to label events. */
  index: number;
  deps: SendDeps;
  signal: AbortSignal;
}): Promise<ChatResponse> {
  const { system, user, estimate, index, deps, signal } = args;
  const call = deps.chat ?? chat;
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    signal.throwIfAborted();

    for (;;) {
      const avail = deps.limiter.check(estimate);
      if (!avail.waitMs) break;
      deps.onEvent({ type: "waiting", ms: avail.waitMs, reason: avail.reason ?? "quota" });
      if (avail.reason === "rpd") {
        throw new LlmError(
          "Daily request quota is used up. The job will resume from here once it resets.",
          429,
          false,
        );
      }
      await sleep(Math.min(avail.waitMs, 15_000), signal);
    }

    deps.limiter.reserve(estimate);
    try {
      const res = await call({
        baseUrl: deps.baseUrl,
        apiKey: deps.apiKey,
        model: deps.model,
        system,
        user,
        maxOutputTokens: deps.maxOutputTokens,
        signal,
      });
      deps.limiter.settle(estimate, res.usage.promptTokens || estimate);
      return res;
    } catch (e) {
      if (signal.aborted) throw e;
      lastError = e;
      if (!(e instanceof LlmError) || !e.retryable) throw e;
      if (e.status === 429) deps.limiter.penalize(e.retryAfter ?? 30);
      const wait = backoffMs(attempt, e.retryAfter);
      deps.onEvent({ type: "retry", index, attempt: attempt + 1, error: e.message });
      await sleep(wait, signal);
    }
  }
  throw lastError;
}

/** Send one wire body, then re-ask for whatever the model dropped. */
export async function translateWire(args: {
  system: string;
  wire: WireChunk;
  estimate: number;
  charsPerToken: number;
  index: number;
  /** What to call this unit of work in the log — "Chunk" for a job, "Request" for a retry. */
  label?: string;
  deps: SendDeps;
  signal: AbortSignal;
}): Promise<{
  translations: Map<string, string>;
  missing: WireLine[];
  usage: { promptTokens: number; completionTokens: number };
}> {
  const { system, wire, charsPerToken, index, deps, signal } = args;

  const first = await sendRequest({ ...args, user: wire.text });
  const parsed = parseResponse(first.content, wire.lines);
  const translations = parsed.translations;
  let missing = parsed.missing;
  const usage = { ...first.usage };

  for (let round = 0; round < MAX_REPAIRS && missing.length; round++) {
    deps.onEvent({ type: "repair", index, missing: missing.length });
    const repairSystem = `${system}\n\n${REPAIR_INSTRUCTION}`;
    const body = serializeRepair(missing);
    const est = estimateTokens(repairSystem + body, charsPerToken);
    const res = await sendRequest({
      system: repairSystem,
      user: body,
      estimate: est,
      index,
      deps,
      signal,
    });
    usage.promptTokens += res.usage.promptTokens;
    usage.completionTokens += res.usage.completionTokens;
    const again = parseResponse(res.content, missing);
    for (const [uid, text] of again.translations) translations.set(uid, text);
    if (again.missing.length === missing.length) break; // making no progress
    missing = again.missing;
  }

  if (first.finishReason === "length") {
    deps.onEvent({
      type: "log",
      message: `${args.label ?? "Request"} ${index + 1} hit the output limit; ${missing.length} line(s) needed repair.`,
    });
  }

  signal.throwIfAborted();
  return { translations, missing, usage };
}
