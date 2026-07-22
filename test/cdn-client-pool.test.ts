import { expect, test } from "bun:test";
import { CDNClientPool } from "../src/backend/cdn-client-pool.ts";

test("selects the lowest-load server and rotates broken connections", () => {
  const slow = { Host: "slow", weightedload: 50, NumEntriesInClientList: 1 };
  const fast = { Host: "fast", weightedload: 10, NumEntriesInClientList: 1 };
  const pool = new CDNClientPool([slow, fast]);

  expect(pool.getConnection()).toBe(fast);
  pool.returnBrokenConnection(fast);
  expect(pool.getConnection()).toBe(slow);
});

test("rotates servers when concurrent callers check out connections", () => {
  const first = { Host: "first", weightedload: 10, NumEntriesInClientList: 1 };
  const second = { Host: "second", weightedload: 20, NumEntriesInClientList: 1 };
  const pool = new CDNClientPool([first, second]);

  expect([pool.getConnection(), pool.getConnection(), pool.getConnection()]).toEqual([first, second, first]);
});

test("does not materialize server entry weights or expand retry counts", () => {
  const weighted = { Host: "weighted", weightedload: 10, NumEntriesInClientList: 1_000_000 };
  const fallback = { Host: "fallback", weightedload: 20, NumEntriesInClientList: 1 };
  const pool = new CDNClientPool([weighted, fallback]);

  expect(pool.attemptsPerChunk).toBe(5);
  expect([pool.getConnection(), pool.getConnection(), pool.getConnection()]).toEqual([weighted, fallback, weighted]);
});
