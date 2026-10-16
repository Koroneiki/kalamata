import { afterEach, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertTransactionSpace } from '../../../../../src/backend/depot/install/transaction/space.ts'

let root: string | undefined
let restore: (() => void) | undefined

afterEach(async () => {
  restore?.()
  restore = undefined
  if (root) await fs.rm(root, { recursive: true, force: true })
  root = undefined
})

for (const scenario of ['state-short', 'game-short', 'enough'] as const) {
  test(`cross-volume space accounts for remaining staging, backups, and freed live blocks: ${scenario}`, async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'kalamata-space-'))
    const state = join(root, 'state')
    const game = join(root, 'game')
    await fs.mkdir(state)
    await fs.mkdir(game)
    await fs.writeFile(join(game, 'old.bin'), 'old')
    const old = await fs.lstat(join(game, 'old.bin'), { bigint: true })
    const stagingBytes = old.blocks * 512n + 7n
    const allocatedStaging = 2n
    const stateRequired = stagingBytes - allocatedStaging + old.size
    const stats = await fs.stat(state)
    const filesystem = await fs.statfs(state, { bigint: true })
    const stat = spyOn(fs, 'stat')
      .mockResolvedValueOnce({ ...stats, dev: 1 })
      .mockResolvedValueOnce({ ...stats, dev: 2 })
    const statfs = spyOn(fs, 'statfs')
      .mockResolvedValueOnce({
        ...filesystem,
        bsize: 1n,
        bavail: stateRequired - (scenario === 'state-short' ? 1n : 0n),
      })
      .mockResolvedValueOnce({
        ...filesystem,
        bsize: 1n,
        bavail: scenario === 'game-short' ? 6n : 7n,
      })
    restore = () => {
      stat.mockRestore()
      statfs.mockRestore()
    }

    const preflight = assertTransactionSpace(
      state,
      game,
      stagingBytes,
      allocatedStaging,
      [{ path: 'old.bin', backup: 'backup/old.bin' }],
    )
    if (scenario === 'enough') await expect(preflight).resolves.toBeUndefined()
    else
      await expect(preflight).rejects.toMatchObject({
        kind: 'insufficient-space',
      })
  })
}
