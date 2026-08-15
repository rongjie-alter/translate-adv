/**
 * Minimal OpenAI-compatible chat client.
 *
 * Deliberately not an SDK: the app only needs one endpoint, and calling it straight
 * from the browser keeps the whole thing static-hostable with no backend to trust
 * with anyone's API key.
 */

export interface ChatRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  system: string;
  user: string;
  maxOutputTokens?: number;
  temperature?: number;
  /** Caps "thinking" tokens on reasoning models. `none`/`low`/`medium`/`high`. */
  reasoningEffort?: string;
  signal?: AbortSignal;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  /** `completionTokens` plus any hidden reasoning tokens billed against `maxOutputTokens`. */
  totalTokens: number;
}

export interface ChatResponse {
  content: string;
  usage: Usage;
  /** `length` means the model ran out of output budget — the caller must repair. */
  finishReason: string;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Worth retrying as-is: rate limits, transient server errors, network blips. */
    readonly retryable: boolean,
    /** Seconds requested by the server, from `Retry-After`. */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export async function chat(req: ChatRequest): Promise<ChatResponse> {
  const url = `${req.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(req.apiKey ? { Authorization: `Bearer ${req.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: req.model,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        temperature: req.temperature ?? 0.3,
        ...(req.maxOutputTokens ? { max_tokens: req.maxOutputTokens } : {}),
        ...(req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {}),
      }),
      signal: req.signal,
    });
  } catch (e) {
    if (req.signal?.aborted) throw e;
    // Also where a CORS rejection lands — the message is deliberately explicit.
    throw new LlmError(
      `Could not reach ${url}. Check the endpoint URL, your connection, and that the ` +
        `endpoint allows browser requests (CORS). (${(e as Error).message})`,
      0,
      true,
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const message = extractError(body) ?? `${res.status} ${res.statusText}`;
    const retryAfter = Number(res.headers.get("retry-after")) || undefined;
    throw new LlmError(message, res.status, res.status === 429 || res.status >= 500, retryAfter);
  }

  const json = (await res.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  const choice = json.choices?.[0];
  if (!choice?.message?.content) {
    throw new LlmError("Endpoint returned no content", res.status, true);
  }

  const promptTokens = json.usage?.prompt_tokens ?? 0;
  const completionTokens = json.usage?.completion_tokens ?? 0;
  return {
    content: choice.message.content,
    finishReason: choice.finish_reason ?? "stop",
    usage: {
      promptTokens,
      completionTokens,
      // Falls back to prompt+completion for endpoints that omit total_tokens; for a
      // reasoning model this field is what actually carries the hidden thinking cost.
      totalTokens: json.usage?.total_tokens ?? promptTokens + completionTokens,
    },
  };
}

function extractError(body: string): string | null {
  try {
    const j = JSON.parse(body);
    return j?.error?.message ?? j?.message ?? null;
  } catch {
    return body.slice(0, 300) || null;
  }
}

/** Exponential backoff with jitter, capped; honours a server-supplied Retry-After. */
export function backoffMs(attempt: number, retryAfter?: number): number {
  if (retryAfter) return retryAfter * 1000;
  const base = Math.min(30_000, 1000 * 2 ** attempt);
  return base + Math.random() * 500;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
