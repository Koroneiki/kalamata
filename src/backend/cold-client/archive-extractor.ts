import { lstat, readdir, realpath } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'

interface ProcessResult {
  exitCode: number
  stdout: string
}

interface ArchiveProcessRunner {
  (command: string[], signal: AbortSignal): Promise<ProcessResult>
}

export class ArchiveExtractor {
  constructor(
    private readonly runProcess: ArchiveProcessRunner = defaultRunProcess,
  ) {}

  async extract(
    extractorPath: string,
    archivePath: string,
    destination: string,
    signal: AbortSignal,
  ): Promise<void> {
    const listing = await this.runProcess(
      [extractorPath, 'l', '-slt', '--', archivePath],
      signal,
    )
    if (listing.exitCode !== 0) throw new Error('Could not inspect archive')
    validateArchiveListing(listing.stdout)

    const extraction = await this.runProcess(
      [
        extractorPath,
        'x',
        '-y',
        '-snl-',
        '-snh-',
        `-o${destination}`,
        '--',
        archivePath,
      ],
      signal,
    )
    if (extraction.exitCode !== 0) throw new Error('Could not extract archive')
    await validateExtractedTree(destination)
  }
}

export function validateArchiveListing(source: string): string[] {
  const separatorIndex = source.indexOf('----------')
  if (separatorIndex < 0) throw new Error('Archive listing is malformed')
  const blocks = source
    .slice(separatorIndex + '----------'.length)
    .split(/\r?\n\r?\n/)
    .map((block) => parseProperties(block))
    .filter((properties) => properties.has('Path'))
  if (blocks.length === 0) throw new Error('Archive is empty')

  const paths: string[] = []
  const seen = new Set<string>()
  for (const properties of blocks) {
    const path = normalizeArchivePath(properties.get('Path')!)
    if (
      [...properties.keys()].some((key) =>
        /symbolic link|hard link|reparse/i.test(key),
      ) ||
      /\bl[rwx-]/i.test(properties.get('Attributes') ?? '')
    ) {
      throw new Error(`Archive entry is a link or reparse point: ${path}`)
    }
    const key = path.toLowerCase()
    if (seen.has(key))
      throw new Error(`Archive contains duplicate path: ${path}`)
    seen.add(key)
    paths.push(path)
  }
  return paths
}

export async function validateExtractedTree(root: string): Promise<void> {
  const canonicalRoot = await realpath(root)
  const entries = await readdir(canonicalRoot, { recursive: true })
  for (const entry of entries) {
    const path = resolve(canonicalRoot, entry)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) {
      throw new Error(`Extracted tree contains a link: ${entry}`)
    }
    const canonicalPath = await realpath(path)
    const fromRoot = relative(canonicalRoot, canonicalPath)
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
      throw new Error(`Extracted path escaped staging: ${entry}`)
    }
  }
}

function parseProperties(block: string): Map<string, string> {
  return new Map(
    block.split(/\r?\n/).flatMap((line) => {
      const separator = line.indexOf(' = ')
      return separator < 0
        ? []
        : [[line.slice(0, separator), line.slice(separator + 3)] as const]
    }),
  )
}

function normalizeArchivePath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '')
  const segments = normalized.split('/')
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.includes(':') ||
    normalized.includes('\0') ||
    segments.some(
      (segment) => segment === '' || segment === '.' || segment === '..',
    )
  ) {
    throw new Error(`Archive contains unsafe path: ${value}`)
  }
  return normalized
}

async function defaultRunProcess(
  command: string[],
  signal: AbortSignal,
): Promise<ProcessResult> {
  signal.throwIfAborted()
  const subprocess = Bun.spawn(command, {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const abort = () => subprocess.kill()
  signal.addEventListener('abort', abort, { once: true })
  try {
    const [exitCode, stdout] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout).text(),
    ])
    signal.throwIfAborted()
    return { exitCode, stdout }
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
