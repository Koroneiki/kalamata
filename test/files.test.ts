import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { adlerForChunk, preflightManifestPaths, rebuildWithChunkMatches, resolveManifestPath, resolveOutputPath } from "../src/files.ts";
import type { ManifestChunk } from "../src/types.ts";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

test("rejects manifest path traversal", () => {
  expect(() => resolveManifestPath("/safe/output", "../outside")).toThrow("escapes output");
  expect(() => resolveManifestPath("/safe/output", "folder\\file.bin")).not.toThrow();
});

test("rejects normalized internal-state aliases", () => {
  expect(() => resolveOutputPath("/safe/output", "ordinary/../.DepotDownloader/config"))
    .toThrow("conflicts with internal state");
});

test("rejects paths traversing an existing symlink", async () => {
  directory = await mkdtemp(join(tmpdir(), "depot-files-"));
  const outside = await mkdtemp(join(tmpdir(), "depot-outside-"));
  try {
    await mkdir(join(directory, "nested"));
    await symlink(outside, join(directory, "nested", "link"));
    await expect(preflightManifestPaths(directory, [{
      filename: "nested/link/file.bin",
      size: "0",
      flags: 0,
      sha_content: "00".repeat(20),
      chunks: [],
    }])).rejects.toThrow("symbolic link");
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("rejects file ancestors even when another path sorts between them", async () => {
  directory = await mkdtemp(join(tmpdir(), "depot-files-"));
  const file = (filename: string) => ({
    filename,
    size: "0",
    flags: 0,
    sha_content: "00".repeat(20),
    chunks: [],
  });
  await expect(preflightManifestPaths(directory, [file("a"), file("a-b"), file("a/child")]))
    .rejects.toThrow("is an ancestor");
});

describe("chunk reuse", () => {
  test("validates and copies valid chunks while rebuilding", async () => {
    directory = await mkdtemp(join(tmpdir(), "depot-files-"));
    const path = join(directory, "file.bin");
    await writeFile(path, "abcdef");
    const chunks: ManifestChunk[] = [chunk("first", 0, "abc"), chunk("second", 3, "def")];

    expect(await adlerForChunk(path, chunks[0]!)).toBe(chunks[0]!.crc);
    await rebuildWithChunkMatches(path, join(directory, "staging.bin"), 6, [{ source: chunks[0]!, destination: chunks[0]! }]);

    expect(await readFile(path, "utf8")).toBe("abc\0\0\0");
  });

  test("calculates Adler checksums across bounded read buffers", async () => {
    directory = await mkdtemp(join(tmpdir(), "depot-files-"));
    const path = join(directory, "large.bin");
    const contents = Buffer.allocUnsafe(150_000);
    for (let index = 0; index < contents.length; index++) contents[index] = index % 251;
    await writeFile(path, contents);
    const manifestChunk = chunk("large", 0, "");
    manifestChunk.cb_original = contents.length;
    manifestChunk.cb_compressed = contents.length;
    manifestChunk.crc = adler(contents);

    expect(await adlerForChunk(path, manifestChunk)).toBe(manifestChunk.crc);
  });

  test("restores the original after rebuilding fails", async () => {
    directory = await mkdtemp(join(tmpdir(), "depot-files-"));
    const path = join(directory, "file.bin");
    const stagingPath = join(directory, "staging.bin");
    await writeFile(path, "original");
    const missing = chunk("missing", 100, "data");

    await expect(rebuildWithChunkMatches(path, stagingPath, 8, [{ source: missing, destination: missing }]))
      .rejects.toThrow("Could not reuse chunk");

    expect(await readFile(path, "utf8")).toBe("original");
    expect(await Bun.file(stagingPath).exists()).toBe(false);
  });
});

function chunk(sha: string, offset: number, value: string): ManifestChunk {
  return {
    sha,
    offset: String(offset),
    cb_original: value.length,
    cb_compressed: value.length,
    crc: adler(Buffer.from(value)),
  };
}

function adler(value: Buffer): number {
  let a = 0;
  let b = 0;
  for (const byte of value) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return (a | (b << 16)) >>> 0;
}
