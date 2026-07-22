import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ManifestChunk, ManifestFile } from "./types.ts";
import { DIRECTORY } from "./local-inputs.ts";

const EXECUTABLE = 32;
export { DIRECTORY };

export function resolveManifestPath(root: string, filename: string): string {
  if (!filename || filename.includes("\0") || isAbsolute(filename)) {
    throw new Error(`Unsafe manifest path: ${filename}`);
  }

  const normalized = filename.replaceAll("\\", "/");
  const outputRoot = resolve(root);
  const outputPath = resolve(outputRoot, normalized);
  const fromRoot = relative(outputRoot, outputPath);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`Manifest path escapes output directory: ${filename}`);
  }
  return outputPath;
}

export function resolveOutputPath(root: string, filename: string): string {
  const outputPath = resolveManifestPath(root, filename);
  const firstSegment = relative(resolve(root), outputPath).split(sep, 1)[0];
  if (firstSegment?.toLowerCase() === ".depotdownloader") {
    throw new Error(`Manifest path conflicts with internal state: ${filename}`);
  }
  return outputPath;
}

export async function assertNoSymlinkTraversal(root: string, filename: string): Promise<void> {
  const outputRoot = resolve(root);
  const outputPath = resolveOutputPath(root, filename);
  const segments = relative(outputRoot, outputPath).split(sep);
  let current = outputRoot;

  // Lexical containment does not prevent traversal through symlinked ancestors.
  // Reject existing symlinks in the manifest path before filesystem operations.
  for (const segment of segments) {
    current = resolve(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`Manifest path traverses a symbolic link: ${filename}`);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return;
      throw error;
    }
  }
}

export async function preflightManifestPaths(
  root: string,
  files: ManifestFile[],
): Promise<void> {
  const paths = new Map<string, { filename: string; directory: boolean }>();
  for (const file of files) {
    const outputPath = resolveOutputPath(root, file.filename);
    const collisionKey = process.platform === "linux" ? outputPath : outputPath.toLowerCase();
    if (paths.has(collisionKey)) throw new Error(`Duplicate manifest path: ${file.filename}`);
    paths.set(collisionKey, { filename: file.filename, directory: Boolean(file.flags & DIRECTORY) });
    await assertNoSymlinkTraversal(root, file.filename);
  }

  const rootKey = process.platform === "linux" ? resolve(root) : resolve(root).toLowerCase();
  for (const [childPath, child] of paths) {
    let ancestor = dirname(childPath);
    while (ancestor !== rootKey && ancestor !== dirname(ancestor)) {
      const parent = paths.get(ancestor);
      if (parent && !parent.directory) {
        throw new Error(`Manifest file path is an ancestor of ${child.filename}: ${parent.filename}`);
      }
      ancestor = dirname(ancestor);
    }
  }
}

export interface StagedPath {
  outputPath: string;
  stagingPath: string;
}

export async function stageTypeTransitions(
  root: string,
  stagingRoot: string,
  currentFiles: ManifestFile[],
  previousFiles: ManifestFile[],
): Promise<StagedPath[]> {
  const previous = new Map(previousFiles.map((file) => [normalizeManifestName(file.filename), file]));
  const staged: StagedPath[] = [];

  try {
    // Stage ancestors first so a file-to-directory transition makes its new
    // descendants reachable regardless of manifest entry order.
    for (const file of [...currentFiles].sort((left, right) => pathDepth(left.filename) - pathDepth(right.filename))) {
      const outputPath = resolveOutputPath(root, file.filename);
      let info;
      try {
        info = await lstat(outputPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (info.isSymbolicLink()) throw new Error(`Manifest path is a symbolic link: ${file.filename}`);

      const wantsDirectory = Boolean(file.flags & DIRECTORY);
      if ((wantsDirectory && info.isDirectory()) || (!wantsDirectory && info.isFile())) continue;
      const oldFile = previous.get(normalizeManifestName(file.filename));
      const oldWasDirectory = oldFile ? Boolean(oldFile.flags & DIRECTORY) : undefined;
      if (oldWasDirectory === undefined || oldWasDirectory === wantsDirectory) {
        throw new Error(`Manifest path has an unexpected filesystem type: ${file.filename}`);
      }

      const stagingPath = resolveManifestPath(stagingRoot, file.filename);
      await mkdir(dirname(stagingPath), { recursive: true });
      await rename(outputPath, stagingPath);
      staged.push({ outputPath, stagingPath });
    }
  } catch (error) {
    try {
      await restoreStagedPaths(staged);
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], "Could not restore partially staged type transitions");
    }
    throw error;
  }
  return staged;
}

export async function restoreStagedPaths(paths: StagedPath[]): Promise<void> {
  const errors: unknown[] = [];
  for (const item of [...paths].reverse()) {
    try {
      await rm(item.outputPath, { recursive: true, force: true });
      await mkdir(dirname(item.outputPath), { recursive: true });
      await rename(item.stagingPath, item.outputPath);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "Could not restore paths after a failed type transition");
}

function normalizeManifestName(filename: string): string {
  const normalized = filename.replaceAll("\\", "/");
  return process.platform === "linux" ? normalized : normalized.toLowerCase();
}

function pathDepth(filename: string): number {
  return filename.replaceAll("\\", "/").split("/").length;
}

export async function prepareDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function preallocate(path: string, size: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "w");
  try {
    await handle.truncate(size);
  } finally {
    await handle.close();
  }
}

export async function existingFileSize(path: string): Promise<number | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`Manifest file path is not a regular file: ${path}`);
    return info.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function adlerForChunk(path: string, chunk: ManifestChunk): Promise<number> {
  const length = Number(chunk.cb_original);
  const buffer = Buffer.allocUnsafe(length);
  const handle = await open(path, "r");
  try {
    const { bytesRead } = await handle.read(buffer, 0, length, Number(chunk.offset));
    if (bytesRead !== length) return -1;
  } finally {
    await handle.close();
  }

  let a = 0;
  let b = 0;
  for (const byte of buffer) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return (a | (b << 16)) >>> 0;
}

export async function findInvalidChunks(path: string, chunks: ManifestChunk[]): Promise<Set<string>> {
  const invalid = new Set<string>();
  for (const chunk of [...chunks].sort((a, b) => Number(a.offset) - Number(b.offset))) {
    if ((await adlerForChunk(path, chunk)) !== chunk.crc >>> 0) invalid.add(chunk.sha);
  }
  return invalid;
}

export async function rebuildWithValidChunks(
  path: string,
  size: number,
  chunks: ManifestChunk[],
  invalid: Set<string>,
): Promise<void> {
  await rebuildWithChunkMatches(
    path,
    `${path}.depotdownloader.tmp`,
    size,
    chunks.filter((chunk) => !invalid.has(chunk.sha)).map((chunk) => ({ source: chunk, destination: chunk })),
  );
}

export interface ChunkMatch {
  source: ManifestChunk;
  destination: ManifestChunk;
}

export async function rebuildWithChunkMatches(
  path: string,
  stagingPath: string,
  size: number,
  matches: ChunkMatch[],
): Promise<void> {
  await mkdir(dirname(stagingPath), { recursive: true });
  await rm(stagingPath, { force: true });
  await rename(path, stagingPath);

  try {
    await preallocate(path, size);
    const source = await open(stagingPath, "r");
    const destination = await open(path, "r+");
    try {
      for (const match of matches) {
        const length = Number(match.source.cb_original);
        const buffer = Buffer.allocUnsafe(length);
        const bytesRead = await readExactly(source, buffer, Number(match.source.offset));
        if (bytesRead !== length) throw new Error(`Could not reuse chunk ${match.source.sha}`);
        await writeExactly(destination, buffer, Number(match.destination.offset));
      }
    } finally {
      await Promise.all([source.close(), destination.close()]);
    }
  } catch (error) {
    await rm(path, { force: true });
    try {
      await rename(stagingPath, path);
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], `Could not restore ${path}; original retained at ${stagingPath}`);
    }
    throw error;
  } finally {
    // Remove staging only when the output path exists; otherwise it may be the remaining copy.
    try {
      await stat(path);
      await rm(stagingPath, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export async function writeChunk(path: string, chunk: ManifestChunk, data: Buffer): Promise<void> {
  if (data.length !== Number(chunk.cb_original)) {
    throw new Error(`Chunk ${chunk.sha} has size ${data.length}, expected ${chunk.cb_original}`);
  }
  const handle = await open(path, "r+");
  try {
    await writeExactly(handle, data, Number(chunk.offset));
  } finally {
    await handle.close();
  }
}

async function readExactly(handle: import("node:fs/promises").FileHandle, buffer: Buffer, position: number): Promise<number> {
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, position + total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return total;
}

async function writeExactly(handle: import("node:fs/promises").FileHandle, buffer: Buffer, position: number): Promise<void> {
  let total = 0;
  while (total < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, total, buffer.length - total, position + total);
    if (bytesWritten === 0) throw new Error("Filesystem write completed without writing data");
    total += bytesWritten;
  }
}

export async function setExecutable(path: string, file: ManifestFile): Promise<void> {
  if (process.platform === "win32") return;
  const mode = (await stat(path)).mode;
  const executeMask = 0o111;
  const desired = file.flags & EXECUTABLE ? mode | executeMask : mode & ~executeMask;
  if (desired !== mode) await chmod(path, desired);
}

export async function verifyFileSha1(path: string, expectedSha1: string): Promise<void> {
  const hash = createHash("sha1");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (data) => hash.update(data));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  if (hash.digest("hex") !== expectedSha1.toLowerCase()) {
    throw new Error(`SHA1 mismatch for file ${path}`);
  }
}
