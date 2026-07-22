import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseManifest } from "./local-inputs.ts";
import type { DepotManifest } from "./types.ts";

export const CONFIG_DIRECTORY = ".DepotDownloader";
export const STAGING_DIRECTORY = "staging";

interface DepotConfigData {
  version: 1;
  installedManifestIds: Record<string, string | null>;
}

export class DepotConfigStore {
  readonly directory: string;
  readonly stagingDirectory: string;
  readonly #filename: string;
  readonly #data: DepotConfigData;

  private constructor(outputDirectory: string, data: DepotConfigData) {
    this.directory = join(outputDirectory, CONFIG_DIRECTORY);
    this.stagingDirectory = join(this.directory, STAGING_DIRECTORY);
    this.#filename = join(this.directory, "depot.config.json");
    this.#data = data;
  }

  static async load(outputDirectory: string): Promise<DepotConfigStore> {
    await assertSafeConfigDirectory(outputDirectory);
    const filename = join(outputDirectory, CONFIG_DIRECTORY, "depot.config.json");
    let contents: string;
    try {
      contents = await readFile(filename, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return new DepotConfigStore(outputDirectory, { version: 1, installedManifestIds: {} });
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new Error(`Invalid depot config ${filename}`, { cause: error });
    }
    if (!isDepotConfigData(parsed)) throw new Error(`Invalid depot config ${filename}`);
    return new DepotConfigStore(outputDirectory, parsed);
  }

  getInstalledManifestId(depotId: number): string | undefined {
    return this.#data.installedManifestIds[String(depotId)] ?? undefined;
  }

  async setInstalledManifestId(depotId: number, manifestId: string | null): Promise<void> {
    this.#data.installedManifestIds[String(depotId)] = manifestId;
    await mkdir(this.directory, { recursive: true });
    await writeAtomically(this.#filename, `${JSON.stringify(this.#data, null, 2)}\n`);
  }

  async loadManifest(depotId: number, manifestId: string, key: Buffer): Promise<DepotManifest | undefined> {
    const filename = this.manifestPath(depotId, manifestId);
    let contents: Buffer;
    let expectedHash: string;
    try {
      [contents, expectedHash] = await Promise.all([
        readFile(filename),
        readFile(`${filename}.sha`, "utf8"),
      ]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }

    const actualHash = sha1(contents);
    if (expectedHash.trim().toLowerCase() !== actualHash) return undefined;
    let manifest: DepotManifest;
    try {
      manifest = parseManifest(contents, key);
    } catch {
      return undefined;
    }
    if (manifest.depot_id !== depotId || manifest.gid_manifest !== manifestId) return undefined;
    return manifest;
  }

  async saveManifest(depotId: number, manifestId: string, contents: Buffer): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const filename = this.manifestPath(depotId, manifestId);
    await writeBufferAtomically(filename, contents);
    await writeAtomically(`${filename}.sha`, `${sha1(contents)}\n`);
  }

  manifestPath(depotId: number, manifestId: string): string {
    return join(this.directory, `${depotId}_${manifestId}.manifest`);
  }
}

export async function acquireOutputLock(outputDirectory: string): Promise<() => Promise<void>> {
  await assertSafeConfigDirectory(outputDirectory);
  const directory = join(outputDirectory, CONFIG_DIRECTORY);
  const lockDirectory = join(directory, "download.lock");
  const ownerPath = join(lockDirectory, "owner.json");
  const owner = { id: randomUUID(), pid: process.pid };
  await mkdir(directory, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(lockDirectory);
      try {
        await writeFile(ownerPath, JSON.stringify(owner));
      } catch (error) {
        await rm(lockDirectory, { recursive: true, force: true });
        throw error;
      }
      return async () => {
        try {
          const current = JSON.parse(await readFile(ownerPath, "utf8")) as { id?: unknown };
          if (current.id === owner.id) await rm(lockDirectory, { recursive: true, force: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readLockOwner(ownerPath);
      if (!existing || processIsAlive(existing.pid)) {
        throw new Error(`Another download is already using ${outputDirectory}`);
      }
      // If the recorded process is no longer alive, remove its stale lock and retry.
      await rm(lockDirectory, { recursive: true, force: true });
    }
  }
  throw new Error(`Could not acquire download lock for ${outputDirectory}`);
}

async function writeAtomically(filename: string, contents: string): Promise<void> {
  await writeBufferAtomically(filename, Buffer.from(contents));
}

async function writeBufferAtomically(filename: string, contents: Buffer): Promise<void> {
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents);
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

function sha1(contents: Buffer): string {
  return createHash("sha1").update(contents).digest("hex");
}

function isDepotConfigData(value: unknown): value is DepotConfigData {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<DepotConfigData>;
  if (data.version !== 1 || !data.installedManifestIds || typeof data.installedManifestIds !== "object") return false;
  return Object.entries(data.installedManifestIds).every(([depotId, manifestId]) =>
    /^\d+$/u.test(depotId) && (manifestId === null || (typeof manifestId === "string" && /^\d+$/u.test(manifestId))),
  );
}

async function assertSafeConfigDirectory(outputDirectory: string): Promise<void> {
  const directory = join(outputDirectory, CONFIG_DIRECTORY);
  for (const path of [directory, join(directory, STAGING_DIRECTORY)]) {
    try {
      if ((await lstat(path)).isSymbolicLink()) {
        throw new Error(`Internal state path must not be a symbolic link: ${path}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function readLockOwner(path: string): Promise<{ pid: number } | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
    return typeof value.pid === "number" && Number.isInteger(value.pid) ? { pid: value.pid } : undefined;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
