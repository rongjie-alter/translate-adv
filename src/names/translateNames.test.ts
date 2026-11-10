import { describe, expect, it } from "vitest";
import type { ChatResponse } from "../llm/client";
import { LlmError } from "../llm/client";
import type { Quota } from "../llm/limiter";
import type { Book, SceneNode, Speaker } from "../scenario/model";
import {
  canTranslateNames,
  containedKnown,
  knownNames,
  MAX_NAMES_PER_REQUEST,
  namesSystemPrompt,
  namesUserMessage,
  parseNamesReply,
  planNames,
  translateNames,
  type NamesDeps,
} from "./translateNames";

const open: Quota = { check: () => ({ waitMs: 0 }), reserve: () => {}, settle: () => {}, penalize: () => {} };

const text = (speaker: Speaker): SceneNode => ({ kind: "text", uid: "c/1", src: "x", hash: "h", speaker });

function book(over: Partial<Book> = {}, speakers: Speaker[] = []): Book {
  return {
    file: "b.book.html",
    srcHash: "h",
    hasMeta: false,
    chapters: [{ name: "c", units: 0, chars: 0, nodes: speakers.map(text) }],
    terms: {
      センセチア: { en: "Sensettia" },
      メリデ: { en: "Melide" },
      ボレアリス: { en: "Borealis" },
      アカシ: { en: "Akashi" },
    },
    ...over,
  } as unknown as Book;
}

describe("canTranslateNames", () => {
  it.each(["gemini-flash-lite", "gemma4-31b", "mock"])("allows %s", (id) => expect(canTranslateNames({ id })).toBe(true));
  it.each(["gemini-flash", "custom-123"])("refuses %s", (id) => expect(canTranslateNames({ id })).toBe(false));
});

describe("knownNames", () => {
  it("merges terms, official speakers and the user's entries, speaker first", () => {
    const b = book({}, [{ jp: "ヨシオリ", tl: { en: "Yoshiori" } }]);
    const k = knownNames({ book: b, lang: "en", custom: { ヨシオリ: "Wrong", ルナ: "Luna" } });
    expect(k.get("センセチア")).toBe("Sensettia");
    expect(k.get("ヨシオリ")).toBe("Yoshiori");
    expect(k.get("ルナ")).toBe("Luna");
  });

  it("honours excluded keys and other languages", () => {
    const k = knownNames({ book: book(), lang: "en", excluded: ["メリデ"] });
    expect(k.has("メリデ")).toBe(false);
    expect(knownNames({ book: book(), lang: "zh-hans" }).size).toBe(0);
  });
});

describe("containedKnown", () => {
  const known = new Map([
    ["センセチア", "Sensettia"],
    ["センセチア変身後", "Sensettia (Transformed)"],
    ["アカシ", "Akashi"],
    ["母", "Mother"],
  ]);

  it("finds the official name inside a longer one", () => {
    expect(containedKnown("センセチアの母", known)).toEqual([["センセチア", "Sensettia"]]);
  });

  it("prefers the longest key and claims the text once", () => {
    expect(containedKnown("センセチア変身後クロスロード", known)).toEqual([
      ["センセチア変身後", "Sensettia (Transformed)"],
    ]);
  });

  it("ignores one-character keys and katakana keys inside a longer word", () => {
    expect(containedKnown("センセチアの母", known).map(([k]) => k)).not.toContain("母");
    expect(containedKnown("アカシア", known)).toEqual([]);
  });

  it("does not count a name as inside itself", () => {
    expect(containedKnown("センセチア", known)).toEqual([]);
  });
});

describe("planNames", () => {
  it("answers exact hits itself and sends the rest with their context", () => {
    const known = new Map([["センセチア", "Sensettia"]]);
    const plan = planNames(["センセチア", "センセチアの母", "音楽祭スタッフ"], known);
    expect([...plan.exact]).toEqual([["センセチア", "Sensettia"]]);
    expect(plan.ask).toEqual(["センセチアの母", "音楽祭スタッフ"]);
    expect(plan.context.get("センセチアの母")).toEqual([["センセチア", "Sensettia"]]);
    expect(plan.context.get("音楽祭スタッフ")).toEqual([]);
  });
});

describe("namesUserMessage", () => {
  it("lists the known pairs once and numbers the names from 1", () => {
    const ctx = new Map<string, [string, string][]>([
      ["センセチアの母", [["センセチア", "Sensettia"]]],
      ["センセチアの父", [["センセチア", "Sensettia"]]],
    ]);
    const msg = namesUserMessage(["センセチアの母", "センセチアの父"], ctx);
    expect(msg.match(/センセチア = Sensettia/g)).toHaveLength(1);
    expect(msg).toContain("1 センセチアの母\n2 センセチアの父");
  });

  it("says so when nothing is known", () => {
    expect(namesUserMessage(["音楽祭スタッフ"], new Map())).toContain("(none)");
  });
});

describe("namesSystemPrompt", () => {
  it("names the language and carries the file note", () => {
    const p = namesSystemPrompt("zh-hant", "タサブロウ is a teenager.");
    expect(p).toContain("Traditional Chinese");
    expect(p).toContain("タサブロウ is a teenager.");
    expect(p).not.toContain("{{");
    expect(namesSystemPrompt("en")).not.toContain("Notes from the user");
  });
});

describe("parseNamesReply", () => {
  const names = ["センセチアの母", "音楽祭スタッフ", "楽団員"];

  it("reads numbered lines", () => {
    const got = parseNamesReply("1 Sensettia's Mother\n2 Music Festival Staff\n3 Band Member", names);
    expect(got.get("センセチアの母")).toBe("Sensettia's Mother");
    expect(got.get("楽団員")).toBe("Band Member");
  });

  it("tolerates fences, bullets, punctuation and an echoed source", () => {
    const reply = "```\n- 1. Sensettia's Mother\n2) \"Music Festival Staff\"\n3 楽団員 = Band Member\n```";
    const got = parseNamesReply(reply, names);
    expect([...got.values()]).toEqual(["Sensettia's Mother", "Music Festival Staff", "Band Member"]);
  });

  it("leaves out a skipped name and ignores unknown numbers", () => {
    const got = parseNamesReply("1 Sensettia's Mother\n9 Stray", names);
    expect(got.size).toBe(1);
    expect(got.has("楽団員")).toBe(false);
  });

  it("keeps a translation that starts with a digit", () => {
    expect(parseNamesReply("1 2nd Squad", ["第二小隊"]).get("第二小隊")).toBe("2nd Squad");
  });

  it("does not read a bare number as an id with a one-digit translation", () => {
    const got = parseNamesReply("12\n2 Music Festival Staff", names);
    expect(got.has("センセチアの母")).toBe(false);
    expect(got.get("音楽祭スタッフ")).toBe("Music Festival Staff");
  });
});

describe("translateNames", () => {
  function deps(reply: (user: string) => string | Error) {
    const sent: { system: string; user: string }[] = [];
    const d: NamesDeps = {
      limiter: open,
      apiKey: "k",
      baseUrl: "http://x",
      model: "m",
      maxOutputTokens: 8192,
      charsPerToken: 1,
      sleep: async () => {},
      chat: async (req): Promise<ChatResponse> => {
        sent.push({ system: req.system, user: req.user });
        const out = reply(req.user);
        if (out instanceof Error) throw out;
        return { content: out, finishReason: "stop", status: 200, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      },
    };
    return { d, sent };
  }
  const ctl = () => new AbortController().signal;

  it("makes one request, sends only relevant known names, and skips exact hits", async () => {
    const known = knownNames({ book: book(), lang: "en" });
    const { d, sent } = deps(() => "1 Sensettia's Mother\n2 Music Festival Staff");
    const res = await translateNames(
      { names: ["センセチア", "センセチアの母", "音楽祭スタッフ"], lang: "en", known },
      d,
      ctl(),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].user).toContain("センセチア = Sensettia");
    expect(sent[0].user).not.toContain("メリデ");
    expect(sent[0].user).not.toContain("1 センセチア\n");
    expect(res.translations.get("センセチア")).toBe("Sensettia");
    expect(res.translations.get("センセチアの母")).toBe("Sensettia's Mother");
    expect(res.exact).toBe(1);
    expect(res.missing).toEqual([]);
  });

  it("reports names the model skipped", async () => {
    const { d } = deps(() => "1 Sensettia's Mother");
    const res = await translateNames(
      { names: ["センセチアの母", "楽団員"], lang: "en", known: new Map([["センセチア", "Sensettia"]]) },
      d,
      ctl(),
    );
    expect(res.missing).toEqual(["楽団員"]);
  });

  it("makes no request when everything is an exact hit", async () => {
    const { d, sent } = deps(() => "");
    const res = await translateNames(
      { names: ["センセチア"], lang: "en", known: new Map([["センセチア", "Sensettia"]]) },
      d,
      ctl(),
    );
    expect(sent).toHaveLength(0);
    expect(res.requests).toBe(0);
    expect(res.translations.get("センセチア")).toBe("Sensettia");
  });

  it("returns the exact hits alongside a fatal error instead of throwing", async () => {
    const { d } = deps(() => new LlmError("bad key", 401, false));
    const res = await translateNames(
      { names: ["センセチア", "楽団員"], lang: "en", known: new Map([["センセチア", "Sensettia"]]) },
      d,
      ctl(),
    );
    expect(res.error?.message).toContain("bad key");
    expect(res.translations.get("センセチア")).toBe("Sensettia");
    expect(res.missing).toEqual(["楽団員"]);
  });

  describe("across several requests", () => {
    // Enough names for two requests; the second holds the last 10.
    const many = Array.from({ length: MAX_NAMES_PER_REQUEST + 10 }, (_, i) => `名前${i}`);
    /** Answers every numbered name in the request as `T<its name>`. */
    const echo = (user: string) => {
      const list = /<names>\n([\s\S]*?)\n<\/names>/.exec(user)![1];
      return list
        .split("\n")
        .map((l) => `${l.split(" ")[0]} T${l.split(" ")[1]}`)
        .join("\n");
    };

    it("numbers each request from 1 and maps every reply back to its own names", async () => {
      const { d, sent } = deps(echo);
      const res = await translateNames({ names: many, lang: "en", known: new Map() }, d, ctl());
      expect(sent).toHaveLength(2);
      expect(res.requests).toBe(2);
      expect(sent[0].user).toContain("1 名前0\n");
      expect(sent[1].user).toContain("<names>\n1 名前150\n");
      expect(res.translations.size).toBe(many.length);
      expect(res.translations.get("名前0")).toBe("T名前0");
      expect(res.translations.get("名前155")).toBe("T名前155");
      expect(res.missing).toEqual([]);
    });

    it("keeps the first request's answers and marks the unsent rest missing when a later one fails", async () => {
      let calls = 0;
      const { d, sent } = deps((user) => (++calls === 2 ? new LlmError("bad key", 401, false) : echo(user)));
      const res = await translateNames(
        { names: many, lang: "en", known: new Map([["センセチア", "Sensettia"]]) },
        d,
        ctl(),
      );
      expect(sent).toHaveLength(2);
      expect(res.requests).toBe(1);
      expect(res.error?.message).toContain("bad key");
      expect(res.translations.size).toBe(MAX_NAMES_PER_REQUEST);
      expect(res.translations.get("名前149")).toBe("T名前149");
      expect(res.missing).toEqual(many.slice(MAX_NAMES_PER_REQUEST));
    });

    it("stops at the first request when it fails, leaving every name missing", async () => {
      const { d, sent } = deps(() => new LlmError("bad key", 401, false));
      const res = await translateNames({ names: many, lang: "en", known: new Map() }, d, ctl());
      expect(sent).toHaveLength(1);
      expect(res.translations.size).toBe(0);
      expect(res.missing).toEqual(many);
    });

    it("rethrows an abort instead of returning it", async () => {
      const c = new AbortController();
      const { d } = deps(() => {
        c.abort();
        return new Error("aborted");
      });
      await expect(translateNames({ names: many, lang: "en", known: new Map() }, d, c.signal)).rejects.toThrow();
    });
  });

  it("reserves quota before every call", async () => {
    const order: string[] = [];
    const { d } = deps(() => {
      order.push("call");
      return "1 Band Member";
    });
    d.limiter = {
      check: () => (order.push("check"), { waitMs: 0 }),
      reserve: () => void order.push("reserve"),
      settle: () => void order.push("settle"),
      penalize: () => {},
    };
    await translateNames({ names: ["楽団員"], lang: "en", known: new Map() }, d, ctl());
    expect(order).toEqual(["check", "reserve", "call", "settle"]);
  });
});
