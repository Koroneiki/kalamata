import type SteamUserType from "steam-user";
import type { ContentServer } from "./content-client.ts";

export interface SteamContentUser extends SteamUserType {
  getContentServers(appId: number): Promise<{ servers: ContentServer[] }>;
  getCDNAuthToken(appId: number, depotId: number, hostname: string): Promise<{ token: string }>;
}

export type SteamUserFactory = () => Promise<SteamContentUser>;

export class SteamSession {
  #client: SteamContentUser | undefined;
  #connecting: Promise<void> | undefined;
  #onConnectionError: ((error: Error) => void) | undefined;
  readonly #connectionErrorListeners = new Set<(error: Error) => void>();
  #disposed = false;

  constructor(private readonly createUser: SteamUserFactory = createSteamUser) {}

  get connected(): boolean {
    return this.#client !== undefined;
  }

  async connect(): Promise<void> {
    if (this.#disposed) throw new Error("Steam session is disposed");
    if (this.#client) return;
    if (!this.#connecting) {
      const connecting = this.#connect();
      this.#connecting = connecting;
      void connecting.finally(() => {
        if (this.#connecting === connecting) this.#connecting = undefined;
      }).catch(() => {});
    }
    await this.#connecting;
  }

  async getClient(): Promise<SteamContentUser> {
    await this.connect();
    if (!this.#client) throw new Error("Steam session is not connected");
    return this.#client;
  }

  onConnectionError(listener: (error: Error) => void): () => void {
    this.#connectionErrorListeners.add(listener);
    return () => this.#connectionErrorListeners.delete(listener);
  }

  dispose(): void {
    this.#disposed = true;
    this.#clearClient();
  }

  async #connect(): Promise<void> {
    const client = await this.createUser();
    if (this.#disposed) {
      client.logOff();
      throw new Error("Steam session is disposed");
    }

    try {
      await logOnAnonymously(client);
      if (this.#disposed) throw new Error("Steam session is disposed");

      const onConnectionError = (error: Error) => {
        if (this.#client !== client) return;
        this.#clearClient();
        for (const listener of this.#connectionErrorListeners) listener(error);
      };
      client.on("error", onConnectionError);
      this.#client = client;
      this.#onConnectionError = onConnectionError;
    } catch (error) {
      client.logOff();
      throw error;
    }
  }

  #clearClient(): void {
    const client = this.#client;
    if (!client) return;
    if (this.#onConnectionError) client.off("error", this.#onConnectionError);
    this.#client = undefined;
    this.#onConnectionError = undefined;
    client.logOff();
  }
}

async function createSteamUser(): Promise<SteamContentUser> {
  // Although VZip uses @napi-rs/lzma, importing steam-user still eagerly loads its
  // lzma@2.3.2 fallback. Under Bun that overwrites onmessage and prevents process exit.
  const previousOnMessage = globalThis.onmessage;
  const { default: SteamUser } = await import("steam-user").finally(() => {
    globalThis.onmessage = previousOnMessage;
  });
  const constructor = SteamUser as unknown as {
    new (options: { dataDirectory: null; autoRelogin: boolean; protocol: number }): SteamContentUser;
    EConnectionProtocol: { TCP: number };
  };
  // Force TCP because Bun integration runs have repeatedly observed WebSocket timeouts.
  return new constructor({
    dataDirectory: null,
    autoRelogin: false,
    protocol: constructor.EConnectionProtocol.TCP,
  });
}

function logOnAnonymously(client: SteamContentUser): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      client.off("loggedOn", onLoggedOn);
      client.off("error", onError);
    };
    const onLoggedOn = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    client.once("loggedOn", onLoggedOn);
    client.once("error", onError);
    client.logOn({ anonymous: true });
  });
}
