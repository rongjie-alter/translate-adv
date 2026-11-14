import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DICTIONARY_FILE,
  backupDictionary,
  backupDictionaryTo,
  dictionaryAdditions,
  forgetFolder,
  listFilesIn,
  mergeDictionaries,
  readArtifactsByNamesFrom,
  readArtifactsFrom,
  readDictionaryFrom,
  writeArtifactTo,
  writeFileIn,
  type DirectoryHandle,
} from "./fsa";
import { artifactFileName, type Artifact } from "./exchange";

// `backupDictionary` resolves the stored handle itself; everything else here takes one.
const stored = vi.hoisted(() => ({ getHandle: vi.fn() }));
vi.mock("./db", () => ({
  getHandle: stored.getHandle,
  putHandle: async () => {},
  clearHandle: async () => {},
}));

/** In-memory stand-in for a picked folder. */
function fakeFolder(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const fileHandle = (name: string) => ({
    kind: "file" as const,
    name,
    getFile: async () => ({ text: async () => files.get(name) ?? "" }) as unknown as File,
    createWritable: async () => ({
      write: async (d: string) => void files.set(name, d),
      close: async () => {},
    }),
  });
  const dir: DirectoryHandle = {
    kind: "directory",
    name: "shared",
    queryPermission: async () => "granted",
    requestPermission: async () => "granted",
    getFileHandle: async (name, opts) => {
      if (!files.has(name) && opts?.create) files.set(name, "");
      return fileHandle(name);
    },
    values: async function* () {
      for (const name of [...files.keys()]) yield fileHandle(name);
    },
  };
  return { dir, files };
}

const artifact: Artifact = {
  v: 1,
  book: "touroumatsuri2026.book.html",
  srcHash: "abc",
  chapter: "tourou2026_0",
  lang: "zh-hant",
  model: "mock",
  generatedAt: 1000,
  units: [{ id: "L0/1", kind: "text", src: "こんにちは", tl: "你好", hash: "h1" }],
  markers: [],
};

describe("folder sync", () => {
  it("writes an artifact under its book/chapter/language name", async () => {
    const { dir, files } = fakeFolder();
    await writeArtifactTo(dir, artifact);
    expect([...files.keys()]).toEqual([artifactFileName(artifact)]);
    expect(JSON.parse(files.get(artifactFileName(artifact))!).units[0].tl).toBe("你好");
  });

  it("reads back what it wrote", async () => {
    const { dir } = fakeFolder();
    await writeArtifactTo(dir, artifact);
    const back = await readArtifactsFrom(dir);
    expect(back).toHaveLength(1);
    expect(back[0].chapter).toBe("tourou2026_0");
    expect(back[0].units[0].tl).toBe("你好");
  });

  it("ignores files that are not translations", async () => {
    const { dir } = fakeFolder({
      "notes.txt": "hello",
      "touroumatsuri2026.book.html": "<html>",
      "combined.bilingual.html": "<html>",
    });
    await writeArtifactTo(dir, artifact);
    expect(await readArtifactsFrom(dir)).toHaveLength(1);
  });

  it("skips one corrupt file rather than losing the rest of the folder", async () => {
    const { dir } = fakeFolder({ "broken.tl.json": "{ not json" });
    await writeArtifactTo(dir, artifact);
    const back = await readArtifactsFrom(dir);
    expect(back).toHaveLength(1);
  });

  it("raises when nothing at all could be read", async () => {
    const { dir } = fakeFolder({ "broken.tl.json": "{ not json" });
    await expect(readArtifactsFrom(dir)).rejects.toThrow(/broken\.tl\.json/);
  });

  it("overwrites an earlier version of the same chapter", async () => {
    const { dir, files } = fakeFolder();
    await writeArtifactTo(dir, artifact);
    await writeArtifactTo(dir, { ...artifact, generatedAt: 2000, model: "newer" });
    expect(files.size).toBe(1);
    expect((await readArtifactsFrom(dir))[0].model).toBe("newer");
  });

  it("lists file names without reading any content", async () => {
    const { dir, files } = fakeFolder({ "notes.txt": "hello", "b.tl.json": "{}" });
    let read = false;
    const spied: DirectoryHandle = {
      ...dir,
      values: async function* () {
        for (const name of [...files.keys()]) {
          yield {
            kind: "file" as const,
            name,
            getFile: async () => {
              read = true;
              throw new Error("should not be called");
            },
            createWritable: async () => ({ write: async () => {}, close: async () => {} }),
          };
        }
      },
    };
    expect(await listFilesIn(spied)).toEqual(["b.tl.json", "notes.txt"]);
    expect(read).toBe(false);
  });

  it("writes the combined file alongside the artifacts", async () => {
    const { dir, files } = fakeFolder();
    await writeArtifactTo(dir, artifact);
    await writeFileIn(dir, "touroumatsuri2026.zh-hant.bilingual.html", "<html>combined</html>");
    expect(files.get("touroumatsuri2026.zh-hant.bilingual.html")).toContain("combined");
    // The combined file must not be picked up as an artifact on the next scan.
    expect(await readArtifactsFrom(dir)).toHaveLength(1);
  });

  describe("dictionary backup", () => {
    const dict = { en: { パラレルフライト: "Parallel Flight" }, "zh-hans": {}, "zh-hant": {} };

    it("writes dictionary.json in the Export JSON shape", async () => {
      const { dir, files } = fakeFolder();
      expect(await backupDictionaryTo(dir, dict)).toBe("written");
      expect(JSON.parse(files.get(DICTIONARY_FILE)!)).toEqual(dict);
    });

    it("overwrites the previous backup instead of adding files", async () => {
      const { dir, files } = fakeFolder();
      await backupDictionaryTo(dir, dict);
      const next = { ...dict, en: { ...dict.en, 少年: "Boy" } };
      expect(await backupDictionaryTo(dir, next)).toBe("written");
      expect([...files.keys()]).toEqual([DICTIONARY_FILE]);
      expect(JSON.parse(files.get(DICTIONARY_FILE)!).en["少年"]).toBe("Boy");
    });

    it("skips the write when nothing changed", async () => {
      const { dir } = fakeFolder();
      await backupDictionaryTo(dir, dict);
      expect(await backupDictionaryTo(dir, dict)).toBe("unchanged");
    });

    it("never replaces a non-empty backup with an empty dictionary", async () => {
      const { dir, files } = fakeFolder();
      await backupDictionaryTo(dir, dict);
      const before = files.get(DICTIONARY_FILE);
      expect(await backupDictionaryTo(dir, { en: {}, "zh-hans": {}, "zh-hant": {} })).toBe("unchanged");
      expect(files.get(DICTIONARY_FILE)).toBe(before);
    });

    it("keeps entries the folder has and the local dictionary lacks", async () => {
      const full = {
        en: { パラレルフライト: "Parallel Flight", 少年: "Boy", 先生: "Teacher" },
        "zh-hans": { 先生: "老师" },
        "zh-hant": {},
      };
      const { dir, files } = fakeFolder({ [DICTIONARY_FILE]: JSON.stringify(full, null, 2) });
      expect(await backupDictionaryTo(dir, dict)).toBe("unchanged");
      expect(JSON.parse(files.get(DICTIONARY_FILE)!)).toEqual(full);
    });

    it("merges both sides, local winning on a shared key", async () => {
      const remote = { en: { 少年: "Kid", 先生: "Teacher" }, "zh-hans": {}, "zh-hant": {} };
      const { dir, files } = fakeFolder({ [DICTIONARY_FILE]: JSON.stringify(remote, null, 2) });
      const local = { en: { 少年: "Boy", パラレルフライト: "Parallel Flight" } };
      expect(await backupDictionaryTo(dir, local)).toBe("written");
      expect(JSON.parse(files.get(DICTIONARY_FILE)!).en).toEqual({
        少年: "Boy",
        先生: "Teacher",
        パラレルフライト: "Parallel Flight",
      });
    });

    it("refuses to overwrite a file that is not a dictionary", async () => {
      for (const junk of ["not json", "[1,2]", JSON.stringify({ 少年: "Boy" })]) {
        const { dir, files } = fakeFolder({ [DICTIONARY_FILE]: junk });
        await expect(backupDictionaryTo(dir, dict)).rejects.toThrow(/not a dictionary backup/);
        expect(files.get(DICTIONARY_FILE)).toBe(junk);
      }
    });

    it("reads the folder's dictionary, or null when there is none", async () => {
      expect(await readDictionaryFrom(fakeFolder().dir)).toBeNull();
      const { dir } = fakeFolder({ [DICTIONARY_FILE]: JSON.stringify(dict) });
      expect(await readDictionaryFrom(dir)).toEqual(dict);
    });

    it("counts only the entries missing locally", () => {
      const remote = { en: { 少年: "Boy", パラレルフライト: "x" }, "zh-hans": { 先生: "老师" } };
      expect(dictionaryAdditions(dict, remote)).toBe(2);
      expect(dictionaryAdditions(remote, dict)).toBe(0);
      expect(mergeDictionaries(remote, dict).en).toEqual({ 少年: "Boy", パラレルフライト: "Parallel Flight" });
    });

    it("writes nothing for an empty dictionary and no existing file", async () => {
      const { dir, files } = fakeFolder();
      expect(await backupDictionaryTo(dir, {})).toBe("empty");
      expect(files.size).toBe(0);
    });

    it("is not mistaken for an artifact on the next scan", async () => {
      const { dir } = fakeFolder();
      await backupDictionaryTo(dir, dict);
      await writeArtifactTo(dir, artifact);
      expect(await readArtifactsFrom(dir)).toHaveLength(1);
    });
  });

  describe("backupDictionary (stored folder)", () => {
    const dict = { en: { パラレルフライト: "Parallel Flight" } };

    /** A folder whose permission starts at `state`; `request` decides what a prompt yields. */
    function folderWith(state: "granted" | "prompt" | "denied", request: () => Promise<string>) {
      const { dir, files } = fakeFolder();
      const handle = {
        ...dir,
        queryPermission: async () => state,
        requestPermission: vi.fn(request),
      } as unknown as DirectoryHandle;
      stored.getHandle.mockResolvedValue(handle);
      return { handle, files };
    }

    beforeEach(async () => {
      stored.getHandle.mockReset();
      await forgetFolder(); // the module caches the handle between calls
    });

    it("reports no-folder when none is stored", async () => {
      stored.getHandle.mockResolvedValue(null);
      expect(await backupDictionary(dict)).toBe("no-folder");
    });

    it("writes when permission is already granted, without prompting", async () => {
      const { handle, files } = folderWith("granted", async () => "granted");
      expect(await backupDictionary(dict)).toBe("written");
      expect(files.has(DICTIONARY_FILE)).toBe(true);
      expect(handle.requestPermission).not.toHaveBeenCalled();
    });

    it("asks for permission when it has lapsed", async () => {
      const { handle, files } = folderWith("prompt", async () => "granted");
      expect(await backupDictionary(dict)).toBe("written");
      expect(handle.requestPermission).toHaveBeenCalledOnce();
      expect(files.has(DICTIONARY_FILE)).toBe(true);
    });

    it("pauses, writing nothing, when the prompt is refused", async () => {
      const { files } = folderWith("prompt", async () => "denied");
      expect(await backupDictionary(dict)).toBe("no-permission");
      expect(files.size).toBe(0);
    });

    it("pauses when the prompt is impossible without a user gesture", async () => {
      const { files } = folderWith("prompt", async () => {
        throw new DOMException("User activation is required", "SecurityError");
      });
      expect(await backupDictionary(dict)).toBe("no-permission");
      expect(files.size).toBe(0);
    });

    it("does not mistake a failing handle lookup for a refused permission", async () => {
      stored.getHandle.mockRejectedValue(new Error("IndexedDB is blocked"));
      await expect(backupDictionary(dict)).rejects.toThrow("IndexedDB is blocked");
    });

    it("does not mistake a failing permission query for a refusal", async () => {
      const { dir } = fakeFolder();
      stored.getHandle.mockResolvedValue({
        ...dir,
        queryPermission: async () => {
          throw new Error("stale handle");
        },
      });
      await expect(backupDictionary(dict)).rejects.toThrow("stale handle");
    });
  });

  it("reads specific artifacts by names", async () => {
    const { dir } = fakeFolder();
    await writeArtifactTo(dir, artifact);
    await writeArtifactTo(dir, { ...artifact, chapter: "tourou2026_1", generatedAt: 1001 });
    const name0 = artifactFileName(artifact);
    const name1 = artifactFileName({ ...artifact, chapter: "tourou2026_1" });
    const back = await readArtifactsByNamesFrom(dir, [name0, name1]);
    expect(back).toHaveLength(2);
    expect(back[0].chapter).toBe("tourou2026_0");
    expect(back[1].chapter).toBe("tourou2026_1");
  });
});

