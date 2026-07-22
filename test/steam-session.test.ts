import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { SteamService } from "../src/index.ts";
import { SteamSession, type SteamContentUser } from "../src/steam-session.ts";

describe("SteamSession", () => {
  test("shares one login across concurrent connect calls", async () => {
    const user = new FakeSteamUser();
    let created = 0;
    const service = new SteamService(new SteamSession(async () => {
      created++;
      return user as unknown as SteamContentUser;
    }));

    await Promise.all([service.connect(), service.connect(), service.connect()]);

    expect(created).toBe(1);
    expect(user.logOnCalls).toBe(1);
    expect(service.connected).toBe(true);

    service.dispose();

    expect(user.logOffCalls).toBe(1);
    expect(service.connected).toBe(false);
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
});

class FakeSteamUser extends EventEmitter {
  logOnCalls = 0;
  logOffCalls = 0;

  logOn(): void {
    this.logOnCalls++;
    queueMicrotask(() => this.emit("loggedOn"));
  }

  logOff(): void {
    this.logOffCalls++;
  }
}
