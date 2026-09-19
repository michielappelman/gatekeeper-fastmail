import { describe, expect, it } from "vitest";
import {
  clearSimulatedKeywordsIfLatest,
  deletePendingAction,
  FOLDER_CACHE_TTL_MS,
  getCachedFolders,
  getPendingAction,
  getSimulatedKeywords,
  mergeSimulatedKeywords,
  putCachedFolders,
  setPendingAction,
  setSimulatedKeywords,
  type CacheKv,
} from "../src/cache";
import type { JmapMailboxObject } from "../src/fastmail-types";

function makeKv(): CacheKv {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string) => store.get(key) as T | undefined,
    put: <T>(key: string, value: T) => void store.set(key, value),
    delete: (key: string) => store.delete(key),
  };
}

const FOLDER: JmapMailboxObject = {
  id: "f1", name: "Inbox", parentId: null, role: "inbox", totalEmails: 3, unreadEmails: 1,
};

describe("folder cache", () => {
  it("returns undefined when nothing is cached", () => {
    expect(getCachedFolders(makeKv(), Date.now())).toBeUndefined();
  });

  it("returns a fresh cache entry", () => {
    const kv = makeKv();
    putCachedFolders(kv, [FOLDER], 1000);
    expect(getCachedFolders(kv, 1000 + FOLDER_CACHE_TTL_MS - 1)).toEqual([FOLDER]);
  });

  it("treats an expired cache entry as absent", () => {
    const kv = makeKv();
    putCachedFolders(kv, [FOLDER], 1000);
    expect(getCachedFolders(kv, 1000 + FOLDER_CACHE_TTL_MS)).toBeUndefined();
  });
});

describe("pending actions", () => {
  it("stores and deletes a pending action", () => {
    const kv = makeKv();
    setPendingAction(kv, 1, { kind: "patch", emailIds: ["e1"], patch: { "keywords/$flagged": true } });
    expect(getPendingAction(kv, 1)).toEqual({
      kind: "patch", emailIds: ["e1"], patch: { "keywords/$flagged": true },
    });
    deletePendingAction(kv, 1);
    expect(getPendingAction(kv, 1)).toBeUndefined();
  });
});

describe("simulated keywords", () => {
  it("is absent until set", () => {
    expect(getSimulatedKeywords(makeKv(), "e1")).toBeUndefined();
  });

  it("returns the latest overlay", () => {
    const kv = makeKv();
    setSimulatedKeywords(kv, "e1", 1, { "$flagged": true });
    expect(getSimulatedKeywords(kv, "e1")).toEqual({ "$flagged": true });
  });

  it("clears only if the given action id is still the latest", () => {
    const kv = makeKv();
    setSimulatedKeywords(kv, "e1", 1, { "$flagged": true });
    setSimulatedKeywords(kv, "e1", 2, { "$seen": false });
    // Resolving the older, superseded action must not clear the newer overlay.
    clearSimulatedKeywordsIfLatest(kv, "e1", 1);
    expect(getSimulatedKeywords(kv, "e1")).toEqual({ "$seen": false });
    clearSimulatedKeywordsIfLatest(kv, "e1", 2);
    expect(getSimulatedKeywords(kv, "e1")).toBeUndefined();
  });

  it("merges an overlay onto real keywords, adding and removing", () => {
    const real = { "$seen": true, "$flagged": false };
    const merged = mergeSimulatedKeywords(real, { "$flagged": true, "$seen": false });
    expect(merged).toEqual({ "$flagged": true });
  });

  it("passes real keywords through unchanged with no overlay", () => {
    const real = { "$seen": true };
    expect(mergeSimulatedKeywords(real, undefined)).toEqual(real);
  });
});
