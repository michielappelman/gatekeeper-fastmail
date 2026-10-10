import { describe, expect, it } from "vitest";
import { FastmailError } from "../src/errors";
import { FASTMAIL_RESOURCE, parseResourceUrl, toResourceUrl } from "../src/resource";

describe("resource", () => {
  it("round-trips the whole-mailbox resource URL", () => {
    const url = toResourceUrl();
    expect(() => parseResourceUrl(url)).not.toThrow();
    expect(url).toBe("https://api.fastmail.com/jmap/mail/account");
  });

  it("matches its own urlPattern", () => {
    expect(new URLPattern(FASTMAIL_RESOURCE.urlPattern).test(toResourceUrl())).toBe(true);
  });

  it("rejects a foreign host", () => {
    expect(() => parseResourceUrl("https://evil.example/jmap/mail/account"))
      .toThrow(FastmailError);
  });

  it("rejects an unrecognized path", () => {
    expect(() => parseResourceUrl("https://api.fastmail.com/jmap/mail/other"))
      .toThrow(FastmailError);
  });

  it("parses the whole mailbox as the mailbox scope", () => {
    expect(parseResourceUrl(toResourceUrl())).toEqual({ kind: "mailbox" });
  });

  it("round-trips a folder scope", () => {
    const url = toResourceUrl({ kind: "folder", folderId: "P2F" });
    expect(url).toBe("https://api.fastmail.com/jmap/mail/account#mailbox/P2F");
    expect(parseResourceUrl(url)).toEqual({ kind: "folder", folderId: "P2F" });
    expect(new URLPattern(FASTMAIL_RESOURCE.urlPattern).test(url)).toBe(true);
  });

  it("round-trips a search scope in canonical form", () => {
    const url = toResourceUrl({ kind: "search", filter: { subject: " Invoice ", from: "billing@example.com", after: "2026-01-01" } });
    expect(parseResourceUrl(url)).toEqual({
      kind: "search", filter: { from: "billing@example.com", subject: "Invoice", after: "2026-01-01T00:00:00Z" },
    });
    // The same filter written in another order mints the same URL.
    expect(toResourceUrl({ kind: "search", filter: { after: "2026-01-01", subject: "Invoice", from: "billing@example.com" } }))
      .toBe(url);
    expect(new URLPattern(FASTMAIL_RESOURCE.urlPattern).test(url)).toBe(true);
  });

  it("rejects malformed scopes", () => {
    const base = toResourceUrl();
    for (const hash of [
      "#mailbox/", "#mailbox/a b", "#label/x", "#search/notjson", `#search/${encodeURIComponent("{}")}`,
      `#search/${encodeURIComponent('{"evil":"x"}')}`, `#search/${encodeURIComponent('{"after":"soon"}')}`,
      `#search/${encodeURIComponent('{"hasKeyword":"a*b"}')}`, `#search/${encodeURIComponent('{"from":1}')}`,
      `#search/${encodeURIComponent('{"after":"2026-02-01","before":"2026-01-01"}')}`,
    ]) {
      expect(() => parseResourceUrl(`${base}${hash}`), hash).toThrow(FastmailError);
    }
  });

  it("rejects a query string", () => {
    expect(() => parseResourceUrl(`${toResourceUrl()}?x=1`)).toThrow(FastmailError);
  });

  it("rejects a malformed URL", () => {
    expect(() => parseResourceUrl("not a url")).toThrow(FastmailError);
  });
});
