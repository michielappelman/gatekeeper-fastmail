import { afterEach, describe, expect, it, vi } from "vitest";
import { bulkSignals } from "../src/bulk";
import { getMessages, queryMessagePage } from "../src/fastmail-api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bulkSignals", () => {
  it("reads a newsletter's list headers", () => {
    expect(bulkSignals({
      "header:List-Id:asText": "Het beste van FTM <nieuwsbrief.ftm.nl>",
      "header:List-Unsubscribe:asURLs": ["mailto:unsub@ftm.nl?subject=stop", "https://ftm.nl/u/123", "javascript:alert(1)"],
      "header:List-Unsubscribe-Post:asText": "List-Unsubscribe=One-Click",
      "header:Precedence:asText": " Bulk ",
    })).toEqual({
      isBulk: true,
      listId: "nieuwsbrief.ftm.nl",
      unsubscribe: ["mailto:unsub@ftm.nl?subject=stop", "https://ftm.nl/u/123"],
      oneClickUnsubscribe: true,
      precedence: "bulk",
    });
  });

  it("counts any single marker as bulk", () => {
    expect(bulkSignals({ "header:List-Id:asText": "list.example.com" })).toEqual({ isBulk: true, listId: "list.example.com" });
    expect(bulkSignals({ "header:List-Unsubscribe:asURLs": ["https://example.com/u"] }).isBulk).toBe(true);
    expect(bulkSignals({ "header:Precedence:asText": "list" }).isBulk).toBe(true);
  });

  it("keeps Auto-Submitted apart from bulk, and ignores 'no'", () => {
    expect(bulkSignals({ "header:Auto-Submitted:asText": "auto-generated" }))
      .toEqual({ isBulk: false, autoSubmitted: "auto-generated" });
    expect(bulkSignals({ "header:Auto-Submitted:asText": "no" })).toEqual({ isBulk: false });
    expect(bulkSignals({ "header:Precedence:asText": "first-class" }))
      .toEqual({ isBulk: false, precedence: "first-class" });
  });

  it("treats a personal message, or missing headers, as not bulk", () => {
    expect(bulkSignals({})).toEqual({ isBulk: false });
    expect(bulkSignals({
      "header:List-Id:asText": null, "header:List-Unsubscribe:asURLs": null, "header:Precedence:asText": "",
    })).toEqual({ isBulk: false });
  });
});

describe("requesting the headers", () => {
  function capture() {
    const calls: [string, any][] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const { methodCalls } = JSON.parse(init.body as string) as { methodCalls: [string, any, string][] };
      calls.push(...methodCalls.map(([name, args]) => [name, args] as [string, any]));
      return new Response(JSON.stringify({
        methodResponses: methodCalls.map(([name, , id]) => [name, name === "Email/query" ? { ids: ["e1"] } : { list: [] }, id]),
      }));
    }));
    return calls;
  }

  it("asks for them in the same Email/get, for messages and listings", async () => {
    const calls = capture();
    await getMessages("https://api/", "t", "u1", false, ["e1"]);
    await queryMessagePage("https://api/", "t", "u1", false, undefined, 0, 25);
    const gets = calls.filter(([name]) => name === "Email/get").map(([, args]) => args.properties as string[]);
    expect(gets).toHaveLength(2);
    for (const properties of gets) {
      expect(properties).toEqual(expect.arrayContaining([
        "header:List-Id:asText", "header:List-Unsubscribe:asURLs", "header:List-Unsubscribe-Post:asText",
        "header:Precedence:asText", "header:Auto-Submitted:asText",
      ]));
    }
  });
});
