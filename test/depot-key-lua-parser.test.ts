import { describe, expect, test } from 'bun:test'
import { parseDepotKeysLua } from '../src/backend/depot/keys/depot-key-lua-parser.ts'

const KEY_A = 'a'.repeat(64)
const KEY_B = 'B'.repeat(64)

describe('parseDepotKeysLua', () => {
  test('extracts requested keys from supported addappid forms', () => {
    const source = [
      `addappid(10, 0, "${KEY_A}")`,
      `addappid(11, '${KEY_B}') -- trailing comment`,
      'addappid(12)',
      `addappid(13, 1, "${KEY_A}")`,
    ].join('\n')

    expect(parseDepotKeysLua(source, new Set([10, 11, 12]))).toEqual(
      new Map([
        [10, KEY_A],
        [11, KEY_B.toLowerCase()],
      ]),
    )
  })

  test('ignores comments, unrelated calls, malformed values, and unrequested depots', () => {
    const source = [
      `-- addappid(10, 0, "${KEY_A}")`,
      `setManifestid(10, "${KEY_A}")`,
      `addappid(not_an_id, 0, "${KEY_A}")`,
      'addappid(10, 0, "short")',
      `addappid(11, 0, "${KEY_A}")`,
    ].join('\n')

    expect(parseDepotKeysLua(source, new Set([10]))).toEqual(new Map())
  })

  test('rejects conflicting keys for one depot', () => {
    expect(() =>
      parseDepotKeysLua(
        `addappid(10, 0, "${KEY_A}")\naddappid(10, 1, "${KEY_B}")`,
        new Set([10]),
      ),
    ).toThrow('conflicting keys')
  })
})
