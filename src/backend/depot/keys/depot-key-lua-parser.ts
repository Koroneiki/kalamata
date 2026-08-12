import { depotKeyFromHex, validateId } from '../../../db/validation.ts'

export function parseDepotKeysLua(
  source: string,
  requestedDepotIds: ReadonlySet<number>,
): Map<number, string> {
  const keys = new Map<number, string>()

  for (const sourceLine of source.split(/\r?\n/u)) {
    const line = stripComment(sourceLine).trim()
    const match = /^addappid\s*\((.*)\)\s*$/u.exec(line)
    if (!match) continue

    const args = splitArguments(match[1])
    if (args.length < 2 || args.length > 3 || !/^\d+$/u.test(args[0])) continue
    const depotId = Number(args[0])
    try {
      validateId(depotId, 'depotId')
    } catch {
      continue
    }
    if (!requestedDepotIds.has(depotId)) continue

    const keyArgument = args
      .slice(1)
      .find((argument) => /^['"][0-9a-fA-F]{64}['"]$/u.test(argument))
    if (!keyArgument) continue
    const key = depotKeyFromHex(keyArgument.slice(1, -1)).toString('hex')
    const existing = keys.get(depotId)
    if (existing && existing !== key) {
      throw new Error(`Lua contains conflicting keys for depot ${depotId}`)
    }
    keys.set(depotId, key)
  }

  return keys
}

function stripComment(line: string): string {
  let quote = ''
  let escaped = false
  for (let index = 0; index < line.length - 1; index += 1) {
    const character = line[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (quote && character === '\\') {
      escaped = true
      continue
    }
    if (character === '"' || character === "'") {
      quote = quote === character ? '' : quote || character
      continue
    }
    if (!quote && character === '-' && line[index + 1] === '-') {
      return line.slice(0, index)
    }
  }
  return line
}

function splitArguments(contents: string): string[] {
  const args: string[] = []
  let start = 0
  let quote = ''
  let escaped = false
  for (let index = 0; index < contents.length; index += 1) {
    const character = contents[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (quote && character === '\\') {
      escaped = true
      continue
    }
    if (character === '"' || character === "'") {
      quote = quote === character ? '' : quote || character
      continue
    }
    if (!quote && character === ',') {
      args.push(contents.slice(start, index).trim())
      start = index + 1
    }
  }
  args.push(contents.slice(start).trim())
  return args
}
