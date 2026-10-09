import { describe, expect, it } from "vitest";
import { describeSend, describeThreadChange, MAX_LISTED_MESSAGES } from "../src/approval";
import { textToHtml } from "../src/fastmail-api";

const field = (rendered: ReturnType<typeof describeSend>, label: string) =>
  rendered.fields?.find(f => f.label === label);

describe("describeSend", () => {
  const params = {
    from: "me@example.com",
    to: [{ email: "anna@example.com", name: "Anna" }],
    cc: [{ email: "bob@example.com" }],
    subject: "Dinner Friday",
    textBody: "Hi Anna,\n\nShall we book at 19:00?\n\nMichiel",
  };

  it("shows every header and the full body, and is complete", () => {
    const rendered = describeSend("Send email.", params);
    expect(field(rendered, "From")).toMatchObject({ kind: "inline", value: "me@example.com" });
    expect(field(rendered, "To")).toMatchObject({ kind: "list", items: ["Anna <anna@example.com>"] });
    expect(field(rendered, "Cc")).toMatchObject({ kind: "list", items: ["bob@example.com"] });
    expect(field(rendered, "Subject")).toMatchObject({ kind: "inline", value: "Dinner Friday" });
    expect(field(rendered, "Plain text")).toMatchObject({ kind: "text", value: params.textBody });
    expect(rendered.descriptionIsComplete).toBe(true);
  });

  it("omits From for a draft without a known sender", () => {
    const { from: _from, ...draft } = params;
    expect(field(describeSend("Save draft.", draft), "From")).toBeUndefined();
  });

  it("shows the derived HTML part exactly as it will be sent", () => {
    const rendered = describeSend("Send email.", params);
    expect(field(rendered, "HTML")).toMatchObject({ kind: "text", value: textToHtml(params.textBody) });
    expect(rendered.description).toContain("generated from the plain text");
  });

  it("shows an explicit HTML body as given, and reply headers", () => {
    const rendered = describeSend("Reply.", {
      ...params, htmlBody: "<p>Hi</p>", inReplyTo: ["abc@mail"], references: ["x@mail", "abc@mail"],
    });
    expect(field(rendered, "HTML")).toMatchObject({ value: "<p>Hi</p>", syntax: "html" });
    expect(rendered.description).not.toContain("generated");
    expect(field(rendered, "In-Reply-To")).toMatchObject({ items: ["<abc@mail>"] });
    expect(field(rendered, "References")).toMatchObject({ items: ["<x@mail>", "<abc@mail>"] });
  });

  it("leaves out absent recipients", () => {
    expect(field(describeSend("Send.", params), "Bcc")).toBeUndefined();
  });
});

describe("describeThreadChange", () => {
  const message = (i: number) => ({
    from: "Anna <anna@example.com>", subject: `Subject ${i}`, receivedAt: "2026-10-01T09:00:00Z",
  });

  it("lists the messages and the extra values", () => {
    const rendered = describeThreadChange("Move.", 2, [message(1), message(2)],
      [{ label: "To folder", value: "Archive" }]);
    expect(rendered.fields).toEqual([
      { label: "To folder", kind: "inline", value: "Archive" },
      {
        label: "Messages (2)", kind: "list",
        items: [
          "2026-10-01 · Anna <anna@example.com> · Subject 1",
          "2026-10-01 · Anna <anna@example.com> · Subject 2",
        ],
      },
    ]);
  });

  it("caps the list and counts the rest", () => {
    const messages = Array.from({ length: MAX_LISTED_MESSAGES + 3 }, (_, i) => message(i));
    const rendered = describeThreadChange("Mark read.", messages.length, messages);
    expect(rendered.fields?.[0]).toMatchObject({ items: { length: MAX_LISTED_MESSAGES } });
    expect(rendered.description).toContain("And 3 more message(s)");
  });

  it("falls back to the count when the messages couldn't be looked up", () => {
    const rendered = describeThreadChange("Mark read.", 4, undefined);
    expect(rendered.fields).toBeUndefined();
    expect(rendered.description).toContain("Applies to 4 message(s)");
  });
});
