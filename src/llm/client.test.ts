import { afterEach, describe, expect, it, vi } from "vitest";
import { chat } from "./client";

function fakeResponse(body: unknown, status = 200) {
  return {
    ok: status < 300,
    status,
    statusText: "OK",
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

const BASE_REQ = {
  apiKey: "k",
  model: "m",
  system: "sys",
  user: "usr",
};

describe("chat", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks Gemini's OpenAI-compat endpoint to include thoughts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await chat({ ...BASE_REQ, baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.extra_body?.google).toEqual({ thinking_config: { include_thoughts: true } });
  });

  it("maps reasoningEffort onto thinking_level for Gemini, except 'none'", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await chat({
      ...BASE_REQ,
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      reasoningEffort: "medium",
    });
    let body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.extra_body?.google).toEqual({ thinking_config: { include_thoughts: true, thinking_level: "medium" } });
    // Google rejects a request carrying both `reasoning_effort` and `thinking_config`.
    expect(body.reasoning_effort).toBeUndefined();

    await chat({
      ...BASE_REQ,
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      reasoningEffort: "none",
    });
    body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.extra_body?.google).toEqual({ thinking_config: { include_thoughts: true } });
  });

  it("omits the google field for non-Gemini endpoints", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await chat({ ...BASE_REQ, baseUrl: "https://api.openai.com/v1" });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.google).toBeUndefined();
  });

  it("parses reasoning content and reasoning token count when the endpoint returns them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        fakeResponse({
          choices: [
            { message: { content: "hi", reasoning_content: "thinking…" }, finish_reason: "stop" },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 20,
            completion_tokens_details: { reasoning_tokens: 5 },
          },
        }),
      ),
    );

    const res = await chat({ ...BASE_REQ, baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" });

    expect(res.status).toBe(200);
    expect(res.reasoning).toBe("thinking…");
    expect(res.usage.reasoningTokens).toBe(5);
    expect(res.usage.totalTokens).toBe(20);
  });

  it("leaves reasoning fields undefined when the endpoint omits them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        fakeResponse({
          choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      ),
    );

    const res = await chat({ ...BASE_REQ, baseUrl: "https://api.openai.com/v1" });

    expect(res.status).toBe(200);
    expect(res.reasoning).toBeUndefined();
    expect(res.usage.reasoningTokens).toBeUndefined();
  });
});
