import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireOutputLock, DepotConfigStore } from "../src/depot-config-store.ts";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

test("persists readable manifest state including the incomplete marker", async () => {
  directory = await mkdtemp(join(tmpdir(), "depot-config-"));
  const store = await DepotConfigStore.load(directory);

  await store.setInstalledManifestId(20, null);
  expect(store.getInstalledManifestId(20)).toBeUndefined();
  await store.setInstalledManifestId(20, "12345678901234567890");

  const reloaded = await DepotConfigStore.load(directory);
  expect(reloaded.getInstalledManifestId(20)).toBe("12345678901234567890");
  expect(JSON.parse(await readFile(join(directory, ".DepotDownloader/depot.config.json"), "utf8"))).toEqual({
    version: 1,
    installedManifestIds: { "20": "12345678901234567890" },
  });
});

test("prevents concurrent downloads in one output directory", async () => {
  directory = await mkdtemp(join(tmpdir(), "depot-config-"));
  const release = await acquireOutputLock(directory);
  try {
    await expect(acquireOutputLock(directory)).rejects.toThrow("already using");
  } finally {
    await release();
  }
  const releaseAgain = await acquireOutputLock(directory);
  await releaseAgain();
});
