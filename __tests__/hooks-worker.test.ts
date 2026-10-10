import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const USER_OBJECT_ID = "c".repeat(64);
const SECRET = "d".repeat(64);

describe("the deployed hook driver", () => {
  it("refuses a push for a subscription it doesn't have", async () => {
    const driver = (env as any).FastmailHookDriver.getByName(USER_OBJECT_ID);
    expect(await driver.receivePush(SECRET, new ArrayBuffer(8))).toBe(false);
  });

  it("answers a push with no subscription behind it with a 404", async () => {
    const response = await (exports as any).default.fetch(new Request(
      `http://localhost:8787/gatekeeper/fastmail/push/${USER_OBJECT_ID}/${SECRET}`,
      { method: "POST", body: new Uint8Array(100) }));
    expect(response.status).toBe(404);
  });
});
