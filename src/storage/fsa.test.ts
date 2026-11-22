import { describe, expect, it } from "vitest";
import {
  listFilesIn,
  readArtifactsByNamesFrom,
  readArtifactsFrom,
  writeArtifactTo,
  writeFileIn,
  type DirectoryHandle,
} from "./fsa";
import { artifactFileName, type Artifact } from "./exchange";

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

