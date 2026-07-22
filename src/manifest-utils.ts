export const DIRECTORY = 64;
export const SYMLINK = 512;
export const MAX_CHUNK_BYTES = 64 * 1024 * 1024;

export function normalizeManifestSeparators(filename: string): string {
  return filename.replaceAll("\\", "/");
}

export function manifestPathKey(filename: string): string {
  const normalized = normalizeManifestSeparators(filename);
  return process.platform === "linux" ? normalized : normalized.toLowerCase();
}
