import http from "node:http";
import https from "node:https";
import type SteamUserType from "steam-user";
import { readFile } from "node:fs/promises";
import { downloadDepotContent } from "./content-downloader.ts";
import type { ChunkClient, ContentServer } from "./download-core.ts";
import { readFileFilter } from "./file-list.ts";
import { parseManifest, readDepotKey, validateManifest } from "./local-inputs.ts";
import { preflightManifestPaths } from "./files.ts";
import type { DownloadDepotOptions, DownloadResult } from "./types.ts";
import { HttpStatusError, buildChunkUrl, contentServerVhost, downloadChunkData } from "./chunk-download.ts";
import { DecompressPool } from "./decompress-pool.ts";

export type { DownloadDepotOptions, DownloadEvent, DownloadResult } from "./types.ts";

type LocalKeySteamUser = SteamUserType & ChunkClient & {
  getDepotDecryptionKey(appId: number, depotId: number): Promise<{ key: Buffer }>;
  getCDNAuthToken(appId: number, depotId: number, hostname: string): Promise<{ token: string }>;
};

export async function downloadDepot(options: DownloadDepotOptions): Promise<DownloadResult> {
  validateOptions(options);
  throwIfAborted(options.signal);
  const [key, manifestContents, fileFilter] = await Promise.all([
    readDepotKey(options.depotKeyPath, options.depotId),
    readFile(options.manifestPath),
    readFileFilter(options.fileListPath),
  ]);
  throwIfAborted(options.signal);
  const manifest = parseManifest(manifestContents, key);
  validateManifest(manifest, options.depotId);
  await preflightManifestPaths(
    options.outputDirectory,
    manifest.files.filter((file) => fileFilter(file.filename)),
  );

  // Although VZip uses @napi-rs/lzma, importing steam-user still eagerly loads its
  // lzma@2.3.2 fallback. Under Bun that overwrites onmessage and prevents process exit.
  const previousOnMessage = globalThis.onmessage;
  const { default: SteamUser } = await import("steam-user").finally(() => {
    globalThis.onmessage = previousOnMessage;
  });
  // Force TCP because Bun integration runs have repeatedly observed WebSocket timeouts.
  const user = new SteamUser({
    dataDirectory: null,
    autoRelogin: false,
    protocol: SteamUser.EConnectionProtocol.TCP,
  }) as LocalKeySteamUser;
  user.getDepotDecryptionKey = async (_appId, depotId) => {
    if (depotId !== options.depotId) throw new Error(`No local key supplied for depot ${depotId}`);
    return { key };
  };
  const decompressPool = new DecompressPool(key, options.maxDownloads ?? 8);
  // Keep connection reuse local to this download instead of mutating the host process's global agents.
  const httpAgent = new http.Agent({ keepAlive: true });
  const httpsAgent = new https.Agent({ keepAlive: true });

  // Override steam-user's downloadChunk with our efficient implementation
  // that avoids O(n²) Buffer.concat behavior on every data event.
  const origGetCDNAuthToken = user.getCDNAuthToken.bind(user);
  const cachedTokens = new Map<string, Promise<string>>();
  const tokenRequiredHosts = new Set<string>();
  user.downloadChunk = async function downloadChunk(
    this: LocalKeySteamUser,
    appId: number,
    depotId: number,
    chunkSha1: string,
    server?: ContentServer,
    signal?: AbortSignal,
    expectedSize?: number,
  ): Promise<{ chunk: Buffer }> {
    if (!server) {
      const { servers } = await this.getContentServers(appId);
      server = servers[Math.floor(Math.random() * servers.length)];
      if (!server) throw new Error("No content servers available");
    }

    const getToken = async (staleToken?: string): Promise<string> => {
      const hostname = contentServerVhost(server);
      const cacheKey = `${depotId}_${hostname}`;
      let promise = cachedTokens.get(cacheKey);
      if (promise && staleToken !== undefined) {
        if (await promise !== staleToken) return promise;
        if (cachedTokens.get(cacheKey) === promise) cachedTokens.delete(cacheKey);
        promise = undefined;
      }
      if (!promise) {
        const requestedToken = origGetCDNAuthToken(appId, depotId, hostname)
          .then((r) => r.token)
          .catch((error) => {
            if (cachedTokens.get(cacheKey) === requestedToken) cachedTokens.delete(cacheKey);
            throw error;
          });
        promise = requestedToken;
        cachedTokens.set(cacheKey, promise);
      }
      return promise;
    };

    const tokenCacheKey = `${depotId}_${contentServerVhost(server)}`;
    let token = server.usetokenauth === 1 || tokenRequiredHosts.has(tokenCacheKey) ? await getToken() : "";

    let location = buildChunkUrl(server, depotId, chunkSha1, token);
    let encrypted: Buffer;
    try {
      encrypted = await downloadChunkData(location.url, location.vhost, signal ?? options.signal, { http: httpAgent, https: httpsAgent });
    } catch (error) {
      // Some servers omit token auth metadata, and cached tokens may expire during long downloads.
      if (!(error instanceof HttpStatusError) || error.statusCode !== 403) throw error;
      tokenRequiredHosts.add(tokenCacheKey);
      token = await getToken(token);
      location = buildChunkUrl(server, depotId, chunkSha1, token);
      encrypted = await downloadChunkData(location.url, location.vhost, signal ?? options.signal, { http: httpAgent, https: httpsAgent });
    }
    const chunk = await decompressPool.process(encrypted, chunkSha1, expectedSize, signal ?? options.signal);
    return { chunk };
  };

  try {
    await logOnAnonymously(user, options.signal);
    options.onEvent?.({ type: "connected" });

    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason ?? new DOMException("Download aborted", "AbortError"));
    const onConnectionError = (error: Error) => controller.abort(error);
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    user.on("error", onConnectionError);

    try {
      return await downloadDepotContent(user, options, {
        manifest,
        manifestContents,
        depotKey: key,
        fileFilter,
      }, controller.signal);
    } finally {
      user.off("error", onConnectionError);
      options.signal?.removeEventListener("abort", onAbort);
    }
  } finally {
    decompressPool.dispose();
    httpAgent.destroy();
    httpsAgent.destroy();
    user.logOff();
  }
}

function validateOptions(options: DownloadDepotOptions): void {
  for (const [name, value] of [["appId", options.appId], ["depotId", options.depotId]] as const) {
    if (!Number.isInteger(value) || value <= 0 || value > 0xffffffff) {
      throw new Error(`${name} must be a positive 32-bit integer`);
    }
  }
  if (!options.manifestPath || !options.depotKeyPath || !options.outputDirectory) {
    throw new Error("manifestPath, depotKeyPath, and outputDirectory are required");
  }
  if (options.maxDownloads !== undefined && (!Number.isInteger(options.maxDownloads) || options.maxDownloads < 1)) {
    throw new Error("maxDownloads must be a positive integer");
  }
}

function logOnAnonymously(user: SteamUserType, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      user.off("loggedOn", onLoggedOn);
      user.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onLoggedOn = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      user.logOff();
      reject(signal?.reason ?? new DOMException("Download aborted", "AbortError"));
    };

    user.once("loggedOn", onLoggedOn);
    user.once("error", onError);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    user.logOn({ anonymous: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}
