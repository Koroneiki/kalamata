import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import type SteamUser from 'steam-user'
import type { SteamContentUser } from './types.ts'
import {
  reportNetworkDiagnostic,
  type NetworkReporter,
  type SteamEndpoint,
} from '../shared/network-diagnostics.ts'

export type { SteamContentUser } from './types.ts'

export type SteamUserFactory = () => Promise<SteamContentUser>

export class SteamSession {
  #client: SteamContentUser | undefined
  #connecting: Promise<void> | undefined
  #onDisconnect: ((error: Error) => void) | undefined
  #finishDiagnostics:
    | ((outcome: 'disconnected' | 'disposed') => void)
    | undefined
  readonly #disconnectListeners = new Set<(error: Error) => void>()
  readonly #disposeController = new AbortController()
  #disposed = false

  constructor(
    private readonly createUser: SteamUserFactory = createSteamUser,
    private readonly reportNetwork: NetworkReporter = reportNetworkDiagnostic,
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
    const connectionId = randomUUID()
    const started = performance.now()
    const endpoint: SteamEndpoint = {}
    const report: NetworkReporter = (event) =>
      reportNetworkDiagnostic(event, this.reportNetwork)
    report({ event: 'steam.session.started', connectionId })
    let client: SteamContentUser | undefined
    const onDebug = (message: string) => {
      // steam-user 5.3 exposes the chosen CM only in debug strings. Extract
      // just the endpoint; raw debug messages can contain credentials.
      const match =
        /^\[[TW]\d+\] Connecting to (TCP CM: |WebSocket CM )([a-zA-Z0-9.-]+):(\d+)$/u.exec(
          message,
        )
      if (!match) return
      endpoint.host = match[2]
      endpoint.port = match[3]
      endpoint.protocol = match[1] === 'TCP CM: ' ? 'tcp' : 'websocket'
      report({ event: 'steam.server-selected', connectionId, ...endpoint })
    }
    try {
      client = await this.createUser()
      if (this.#disposed) throw new Error('Steam session is disposed')
      client.on('debug', onDebug)
      await logOnAnonymously(client, this.#disposeController.signal)
      if (this.#disposed) throw new Error('Steam session is disposed')

      const connectedClient = client
      const onDisconnect = (error: Error) => {
        if (this.#client !== connectedClient) return
        this.#clearClient('disconnected')
        for (const listener of this.#disconnectListeners) listener(error)
      }
      client.on('error', onDisconnect)
      this.#client = client
      this.#onDisconnect = onDisconnect
      this.#finishDiagnostics = (outcome) => {
        connectedClient.off('debug', onDebug)
        report({
          event: 'steam.session.finished',
          connectionId,
          ...endpoint,
          durationMs: performance.now() - started,
          outcome,
        })
      }
      report({ event: 'steam.session.connected', connectionId, ...endpoint })
    } catch (error) {
      client?.off('debug', onDebug)
      report({
        event: 'steam.session.finished',
        connectionId,
        ...endpoint,
        durationMs: performance.now() - started,
        outcome: this.#disposed ? 'cancelled' : 'failed',
      })
      client?.logOff()
      throw error
    }
  }

  #clearClient(outcome: 'disconnected' | 'disposed' = 'disposed'): void {
    const client = this.#client
    if (!client) return
    if (this.#onDisconnect) client.off('error', this.#onDisconnect)
    this.#client = undefined
    this.#onDisconnect = undefined
    this.#finishDiagnostics?.(outcome)
    this.#finishDiagnostics = undefined
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
  // Bun 1.4 stalls TCP, while Electrobun's bundled Bun 1.3 stalls WebSocket.
  const protocol = Bun.version.startsWith('1.4.')
    ? SteamUser.EConnectionProtocol.WebSocket
    : SteamUser.EConnectionProtocol.TCP
  const client = new SteamUser({
    dataDirectory: null,
    autoRelogin: false,
    protocol,
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
