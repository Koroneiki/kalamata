import { readFile, writeFile } from 'node:fs/promises'

interface ColdClientLoaderValues {
  executableRelativePath: string
  appId: number
  launchArguments: string
}

const keys = ['Exe', 'ExeCommandLine', 'AppId', 'DllsToInjectFolder'] as const
type IniKey = (typeof keys)[number]
type IniEncoding = 'utf8' | 'utf8-bom' | 'utf16le'

interface DecodedIni {
  text: string
  encoding: IniEncoding
}

export async function updateColdClientLoaderIni(
  path: string,
  values: ColdClientLoaderValues,
): Promise<void> {
  for (const value of [values.executableRelativePath, values.launchArguments]) {
    if (/[\0\r\n]/u.test(value)) {
      throw new Error('ColdClient loader values must fit on one line')
    }
  }

  const source = await readFile(path)
  const decoded = decodeIni(source)
  const newline = decoded.text.includes('\r\n') ? '\r\n' : '\n'
  const trailingNewline = decoded.text.endsWith('\n')
  const replacements = {
    Exe: `..\\${values.executableRelativePath.replaceAll('/', '\\')}`,
    ExeCommandLine: values.launchArguments,
    AppId: String(values.appId),
    DllsToInjectFolder: 'extra_dlls',
  } satisfies Record<IniKey, string>
  const seen = new Set<string>()
  const lines = decoded.text.split(/\r?\n/u)
  if (trailingNewline) lines.pop()
  const updated = lines.map((line) => {
    const match = /^([A-Za-z][A-Za-z0-9]*)=/u.exec(line)
    if (!match || !isIniKey(match[1])) return line
    const key = match[1]
    if (seen.has(key)) throw new Error(`ColdClient loader INI repeats ${key}`)
    seen.add(key)
    return `${key}=${replacements[key]}`
  })
  for (const key of keys) {
    if (!seen.has(key))
      throw new Error(`ColdClient loader INI is missing ${key}`)
  }
  const text = `${updated.join(newline)}${trailingNewline ? newline : ''}`
  await writeFile(path, encodeIni(text, decoded.encoding))
}

function decodeIni(source: Buffer): DecodedIni {
  if (source.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) {
    return { text: source.subarray(2).toString('utf16le'), encoding: 'utf16le' }
  }
  if (source.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) {
    throw new Error('Big-endian ColdClient loader INI is not supported')
  }
  const hasBom = source.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
  const body = hasBom ? source.subarray(3) : source
  const text = new TextDecoder('utf-8', { fatal: true }).decode(body)
  return { text, encoding: hasBom ? 'utf8-bom' : 'utf8' }
}

function isIniKey(value: string): value is IniKey {
  return keys.some((key) => key === value)
}

function encodeIni(text: string, encoding: IniEncoding): Buffer {
  if (encoding === 'utf16le') {
    return Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(text, 'utf16le'),
    ])
  }
  const body = Buffer.from(text, 'utf8')
  return encoding === 'utf8-bom'
    ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body])
    : body
}
