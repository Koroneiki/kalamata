import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileFilter } from "../src/file-list.ts";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

test("matches literal paths and regex entries case-insensitively", async () => {
  directory = await mkdtemp(join(tmpdir(), "depot-file-list-"));
  const path = join(directory, "files.txt");
  await writeFile(path, "bin\\game.exe\nregex:^data/.+\\.pak$\n");

  const includes = await readFileFilter(path);
  expect(includes("BIN/game.exe")).toBe(true);
  expect(includes("Data/content.PAK")).toBe(true);
  expect(includes("data/readme.txt")).toBe(false);
});

test("preserves whitespace in literal manifest paths", async () => {
  directory = await mkdtemp(join(tmpdir(), "depot-file-list-"));
  const path = join(directory, "files.txt");
  await writeFile(path, "  spaced/file.txt  \n   \n");

  const includes = await readFileFilter(path);
  expect(includes("  SPACED/file.txt  ")).toBe(true);
  expect(includes("spaced/file.txt")).toBe(false);
});

test("reports the file and line for invalid regular expressions", async () => {
  directory = await mkdtemp(join(tmpdir(), "depot-file-list-"));
  const path = join(directory, "files.txt");
  await writeFile(path, "ordinary.txt\nregex:[\n");

  await expect(readFileFilter(path)).rejects.toThrow(`${path}:2`);
});
