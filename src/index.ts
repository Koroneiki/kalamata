import { DepotDownloadService } from "./depot-download-service.ts";
import { SteamSession } from "./steam-session.ts";
import type { DownloadDepotOptions, DownloadResult } from "./types.ts";

export type { DownloadDepotOptions, DownloadEvent, DownloadResult } from "./types.ts";

export class SteamService {
  readonly #downloads: DepotDownloadService;

  constructor(private readonly session = new SteamSession()) {
    this.#downloads = new DepotDownloadService(session);
  }

  get connected(): boolean {
    return this.session.connected;
  }

  connect(): Promise<void> {
    return this.session.connect();
  }

  downloadDepot(options: DownloadDepotOptions): Promise<DownloadResult> {
    return this.#downloads.download(options);
  }

  dispose(): void {
    this.session.dispose();
  }
}

export function createSteamService(): SteamService {
  return new SteamService();
}
