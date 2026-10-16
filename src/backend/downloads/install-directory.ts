import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { canonicalizeInstallDirectory } from '../../db/validation.ts'
import type { SteamService } from '../index.ts'
import { writeDurableJson } from '../filesystem/durable-json.ts'

const historySchema = z.strictObject({ baseDirectory: z.string().min(1) })
const productSchema = z.object({
  config: z.object({ installdir: z.string().optional() }).optional(),
})

export class InstallDirectoryService {
  readonly #historyPath: string

  constructor(
    userDataRoot: string,
    private readonly products: Pick<SteamService, 'getProductInfo'>,
    private readonly pickDirectory: (
      startingFolder: string | null,
    ) => Promise<string | null>,
  ) {
    this.#historyPath = join(userDataRoot, 'history', 'install-directory.json')
  }

  async get(appId: number): Promise<string | null> {
    const baseDirectory = await this.lastDirectory()
    return baseDirectory ? this.installPath(appId, baseDirectory) : null
  }

  async select(appId: number): Promise<string | null> {
    const selected = await this.pickDirectory(await this.lastDirectory())
    if (!selected) return null
    const { path: baseDirectory } = await canonicalizeInstallDirectory(selected)
    // Remember only the confirmed parent, never a game's derived install path.
    await writeDurableJson(this.#historyPath, { baseDirectory })
    return this.installPath(appId, baseDirectory)
  }

  private async lastDirectory(): Promise<string | null> {
    try {
      const { baseDirectory } = historySchema.parse(
        JSON.parse(await readFile(this.#historyPath, 'utf8')),
      )
      return (await canonicalizeInstallDirectory(baseDirectory)).path
    } catch {
      // Missing, damaged or unavailable history requires a fresh manual choice.
      return null
    }
  }

  private async installPath(
    appId: number,
    baseDirectory: string,
  ): Promise<string> {
    const product = await this.products.getProductInfo(appId)
    const name = productSchema.safeParse(product.appinfo).data?.config
      ?.installdir
    // Product metadata must be a single portable folder name, not a path.
    const valid =
      name &&
      name.trim() &&
      !/[<>:"/\\|?*\p{Cc}]/u.test(name) &&
      !/[. ]$/u.test(name) &&
      !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(name)
    return join(baseDirectory, valid ? name : `App ${appId}`)
  }
}
