import { describe, expect, it, vi } from "vitest";

vi.mock("@gadgets/configurator-ui", () => ({
  h: (component: unknown, props: unknown, ...children: unknown[]) => ({ component, props, children }),
  Field: "Field",
  Section: "Section",
}));
import { FastmailAccountConfiguratorUI } from "../src/fastmail";
import { toResourceUrl } from "../src/resource";
import configuratorSpec from "../src/configurator/fastmail-account-configurator-ui";

// startResourceConfigurator() previously threw unconditionally for the whole-mailbox resource. That
// leaves "Add connection" permanently disabled in the connect modal: it drives every
// SupportedResource through this configurator regardless of whether the resource has any real
// user-selectable fields, with no fallback for a rejection. These tests cover the fix: a trivial
// configurator (this RPC target, and the UI spec that calls it) that always resolves.
describe("FastmailAccountConfiguratorUI", () => {
  it("reports the fixed whole-mailbox resource URL", async () => {
    const ui = new FastmailAccountConfiguratorUI();
    await expect(ui.resourceUrl()).resolves.toBe(toResourceUrl());
  });
});

describe("fastmail-account-configurator-ui spec", () => {
  it("is always ready, with no user-selectable fields", () => {
    expect(configuratorSpec.isReady?.({ values: configuratorSpec.initial })).toBe(true);
  });

  it("delegates resourceUrl() to the ui capability", async () => {
    const ui = { resourceUrl: async () => toResourceUrl() };
    await expect(configuratorSpec.resourceUrl({ values: configuratorSpec.initial, ui }))
      .resolves.toBe(toResourceUrl());
  });
});
