import { once } from 'node:events'
import type SteamUser from 'steam-user'
import type { SteamContentUser } from './types.ts'

export type { SteamContentUser } from './types.ts'

export type SteamUserFactory = () => Promise<SteamContentUser>

export class SteamSession {
  #client: SteamContentUser | undefined
  #connecting: Promise<void> | undefined
  #onDisconnect: ((error: Error) => void) | undefined
  readonly #disconnectListeners = new Set<(error: Error) => void>()
  readonly #disposeController = new AbortController()
  #disposed = false

  constructor(
    private readonly createUser: SteamUserFactory = createSteamUser,
  ) {}

  get connected(): boolean {
    return this.#client !== undefined
  }

  async connect(): Promise<void> {
    if (this.#disposed) throw new Error('Steam session is disposed')
    if (this.#client) return
    if (!this.#connecting) {
      const connecting = this.#connect()
      this.#connecting = connecting
      void connecting
        .finally(() => {
          if (this.#connecting === connecting) this.#connecting = undefined
        })
        .catch(() => {})
    }
    await this.#connecting
  }

  async getClient(): Promise<SteamContentUser> {
    await this.connect()
    if (!this.#client) throw new Error('Steam session is not connected')
    return this.#client
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.#disconnectListeners.add(listener)
    return () => this.#disconnectListeners.delete(listener)
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    const error = new Error('Steam session is disposed')
    this.#disposeController.abort(error)
    const listeners = [...this.#disconnectListeners]
    this.#disconnectListeners.clear()
    this.#clearClient()
    for (const listener of listeners) listener(error)
  }

  async #connect(): Promise<void> {
    const client = await this.createUser()
    if (this.#disposed) {
      client.logOff()
      throw new Error('Steam session is disposed')
    }

    try {
      await logOnAnonymously(client, this.#disposeController.signal)
      if (this.#disposed) throw new Error('Steam session is disposed')

      const onDisconnect = (error: Error) => {
        if (this.#client !== client) return
        this.#clearClient()
        for (const listener of this.#disconnectListeners) listener(error)
      }
      client.on('error', onDisconnect)
      this.#client = client
      this.#onDisconnect = onDisconnect
    } catch (error) {
      client.logOff()
      throw error
    }
  }

  #clearClient(): void {
    const client = this.#client
    if (!client) return
    if (this.#onDisconnect) client.off('error', this.#onDisconnect)
    this.#client = undefined
    this.#onDisconnect = undefined
    client.logOff()
  }
}

async function createSteamUser(): Promise<SteamContentUser> {
  // Although VZip uses @napi-rs/lzma, importing steam-user still eagerly loads its
  // lzma@2.3.2 fallback. Under Bun that overwrites onmessage and prevents process exit.
  const previousOnMessage = globalThis.onmessage
  const { default: SteamUser } = await import('steam-user').finally(() => {
    globalThis.onmessage = previousOnMessage
  })
  // Force TCP because Bun integration runs have repeatedly observed WebSocket timeouts.
  const client = new SteamUser({
    dataDirectory: null,
    autoRelogin: false,
    protocol: SteamUser.EConnectionProtocol.TCP,
  })
  if (!isSteamContentUser(client))
    throw new Error('steam-user does not provide content server methods')
  return client
}

function isSteamContentUser(client: SteamUser): client is SteamContentUser {
  return (
    'getContentServers' in client &&
    client.getContentServers instanceof Function &&
    'getCDNAuthToken' in client &&
    client.getCDNAuthToken instanceof Function
  )
}

async function logOnAnonymously(
  client: SteamContentUser,
  signal: AbortSignal,
): Promise<void> {
  const loggedOn = once(client, 'loggedOn', { signal })
  client.logOn({ anonymous: true })
  try {
    await loggedOn
  } catch (error) {
    if (signal.aborted) throw signal.reason
    throw error
  }
}
