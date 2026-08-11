const MAX_LINES = 1_000
const ROOTS = ['src', 'test', 'scripts']
const EXCLUDED_PREFIXES = ['src/components/ui/', 'src/db/migrations/']
const sourceFiles = new Bun.Glob('**/*.{ts,tsx,vue,js,jsx,css,sql}')

const oversized: Array<{ path: string; lines: number }> = []

for (const root of ROOTS) {
  for await (const relativePath of sourceFiles.scan({ cwd: root })) {
    const path = `${root}/${relativePath}`
    if (EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix))) continue

    const contents = await Bun.file(path).text()
    const lines =
      contents.length === 0
        ? 0
        : contents.split(/\r?\n/u).length - (contents.endsWith('\n') ? 1 : 0)
    if (lines > MAX_LINES) oversized.push({ path, lines })
  }
}

if (oversized.length > 0) {
  for (const file of oversized.sort((left, right) => right.lines - left.lines))
    console.error(`${file.path}: ${file.lines} lines (maximum ${MAX_LINES})`)
  process.exit(1)
}

console.log(`All hand-written source files are within ${MAX_LINES} lines.`)
