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

  it("rejects a hash-scoped URL, since v1 supports no per-folder/search scoping", () => {
    expect(() => parseResourceUrl(`${toResourceUrl()}#mailbox/inbox`)).toThrow(FastmailError);
  });

  it("rejects a malformed URL", () => {
    expect(() => parseResourceUrl("not a url")).toThrow(FastmailError);
  });
});
