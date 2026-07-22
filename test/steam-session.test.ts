import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { SteamSession, type SteamContentUser } from "../src/steam-session.ts";

describe("SteamSession", () => {
  test("shares one login across concurrent connect calls", async () => {
    const user = new FakeSteamUser();
    let created = 0;
    const session = new SteamSession(async () => {
      created++;
      return user as unknown as SteamContentUser;
    });

    await Promise.all([session.connect(), session.connect(), session.connect()]);

    expect(created).toBe(1);
    expect(user.logOnCalls).toBe(1);
    expect(session.connected).toBe(true);

    session.dispose();

    expect(user.logOffCalls).toBe(1);
    expect(session.connected).toBe(false);
  });

  test("creates a fresh client after a connected client fails", async () => {
    const first = new FakeSteamUser();
    const second = new FakeSteamUser();
    const users = [first, second];
    const session = new SteamSession(async () => {
      const user = users.shift();
      if (!user) throw new Error("Unexpected Steam client creation");
      return user as unknown as SteamContentUser;
    });

    await session.connect();
    first.emit("error", new Error("connection lost"));

    expect(session.connected).toBe(false);
    expect(first.logOffCalls).toBe(1);

    await session.connect();

    expect(second.logOnCalls).toBe(1);
    expect(session.connected).toBe(true);
    session.dispose();
  });

  test("cancels an in-progress login when disposed", async () => {
    const user = new FakeSteamUser(false);
    const session = new SteamSession(async () => user as unknown as SteamContentUser);
    const connecting = session.connect();
    await Promise.resolve();

    session.dispose();

    await expect(connecting).rejects.toThrow("Steam session is disposed");
    expect(user.logOffCalls).toBe(1);
  });

  test("notifies active operations when disposed", async () => {
    const user = new FakeSteamUser();
    const session = new SteamSession(async () => user as unknown as SteamContentUser);
    await session.connect();
    let disconnectError: Error | undefined;
    session.onDisconnect((error) => {
      disconnectError = error;
    });

    session.dispose();

    expect(disconnectError?.message).toBe("Steam session is disposed");
  });
});

class FakeSteamUser extends EventEmitter {
  logOnCalls = 0;
  logOffCalls = 0;

  constructor(private readonly completeLogin = true) {
    super();
  }

  logOn(): void {
    this.logOnCalls++;
    if (this.completeLogin) queueMicrotask(() => this.emit("loggedOn"));
  }

  logOff(): void {
    this.logOffCalls++;
  }
}
