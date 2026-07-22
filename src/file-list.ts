import { readFile } from "node:fs/promises";

export type FileFilter = (filename: string) => boolean;

export async function readFileFilter(path?: string): Promise<FileFilter> {
  if (!path) return () => true;

  const literalPaths = new Set<string>();
  const patterns: RegExp[] = [];
  for (const rawLine of (await readFile(path, "utf8")).split(/\r?\n/u)) {
    if (!rawLine.trim()) continue;
    if (rawLine.startsWith("regex:")) {
      patterns.push(new RegExp(rawLine.slice("regex:".length), "iu"));
    } else {
      literalPaths.add(normalizeForMatch(rawLine));
    }
  }

  return (filename) => {
    const normalized = filename.replaceAll("\\", "/");
    return literalPaths.has(normalized.toLowerCase()) || patterns.some((pattern) => pattern.test(normalized));
  };
}

function normalizeForMatch(filename: string): string {
  return filename.replaceAll("\\", "/").toLowerCase();
}
