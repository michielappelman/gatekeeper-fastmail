import { describe, expect, it, vi } from "vitest";

vi.mock("@gadgets/configurator-ui", () => ({
  h: (component: unknown, props: unknown, ...children: unknown[]) => ({ component, props, children }),
  Field: "Field",
  Section: "Section",
  RadioCards: "RadioCards",
  TextInput: "TextInput",
  Autocomplete: "Autocomplete",
}));
import { FastmailAccountConfiguratorUI } from "../src/fastmail";
import { FastmailError } from "../src/errors";
import { toResourceUrl } from "../src/resource";
import configuratorSpec from "../src/configurator/fastmail-account-configurator-ui";

const GRANT = { apiToken: "t", apiUrl: "https://api/", accountId: "u1", hasSubmission: true };

describe("FastmailAccountConfiguratorUI", () => {
  it("mints the whole-mailbox URL by default", async () => {
    const ui = new FastmailAccountConfiguratorUI();
    await expect(ui.resourceUrl()).resolves.toBe(toResourceUrl());
    await expect(ui.resourceUrl({ mode: "all" })).resolves.toBe(toResourceUrl());
  });

  it("mints folder and search URLs, and reads them back", async () => {
    const ui = new FastmailAccountConfiguratorUI();
    const folderUrl = await ui.resourceUrl({ mode: "folder", folderId: "P2F" });
    expect(folderUrl).toBe(toResourceUrl({ kind: "folder", folderId: "P2F" }));
    await expect(ui.valuesFromResourceUrl(folderUrl)).resolves.toEqual({ mode: "folder", folderId: "P2F" });

    const searchUrl = await ui.resourceUrl({ mode: "search", from: "billing@example.com", searchFolderId: "P2F" });
    await expect(ui.valuesFromResourceUrl(searchUrl)).resolves.toEqual({
      mode: "search", from: "billing@example.com", to: null, subject: null, text: null, searchFolderId: "P2F",
    });
  });

  it("refuses an incomplete folder or search", async () => {
    const ui = new FastmailAccountConfiguratorUI();
    await expect(ui.resourceUrl({ mode: "folder" })).rejects.toThrow(FastmailError);
    await expect(ui.resourceUrl({ mode: "search", from: "  " })).rejects.toThrow(FastmailError);
  });

  it("lists folders by path, filtered by the query", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ methodResponses: [["Mailbox/get", { list: [
      { id: "i", name: "Inbox", parentId: null, role: "inbox", totalEmails: 3, unreadEmails: 0 },
      { id: "w", name: "Work", parentId: null, role: null, totalEmails: 0, unreadEmails: 0 },
      { id: "r", name: "Receipts", parentId: "w", role: null, totalEmails: 7, unreadEmails: 0 },
    ] }, "c1"]] }))));
    const ui = new FastmailAccountConfiguratorUI({ getGrant: async () => GRANT } as any);
    const options = await ui.listFolders("rec");
    expect(options).toEqual([{ value: "r", title: "Work / Receipts", subtitle: undefined, meta: "7 message(s)" }]);
    expect((await ui.listFolders("")).map(option => option.value)).toEqual(["i", "w", "r"]);
    vi.unstubAllGlobals();
  });
});

describe("fastmail-account-configurator-ui spec", () => {
  it("is ready for the whole mailbox, and only once a folder or search condition is chosen", () => {
    const ready = (values: Record<string, string | null>) => configuratorSpec.isReady?.({ values });
    expect(ready(configuratorSpec.initial)).toBe(true);
    expect(ready({ mode: "folder" })).toBe(false);
    expect(ready({ mode: "folder", folderId: "P2F" })).toBe(true);
    expect(ready({ mode: "search", from: " " })).toBe(false);
    expect(ready({ mode: "search", subject: "Invoice" })).toBe(true);
  });

  it("delegates resourceUrl() to the ui capability with the form values", async () => {
    const ui = { resourceUrl: vi.fn(async () => "url") };
    await expect(configuratorSpec.resourceUrl({ values: { mode: "folder", folderId: "P2F" }, ui: ui as any }))
      .resolves.toBe("url");
    expect(ui.resourceUrl).toHaveBeenCalledWith({ mode: "folder", folderId: "P2F" });
  });
});
