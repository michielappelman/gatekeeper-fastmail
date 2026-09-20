import { describe, expect, it, vi } from "vitest";
import { assertMarkdownConvertible, convertToMarkdown, MARKDOWN_CONVERT_MAX_BYTES } from "../src/markdown";

function fakeAi(toMarkdown: (...args: unknown[]) => unknown): Ai {
  return { toMarkdown } as unknown as Ai;
}

describe("assertMarkdownConvertible", () => {
  it("does not throw for a supported MIME type within the size cap", () => {
    expect(() => assertMarkdownConvertible("application/pdf", 1000)).not.toThrow();
  });

  it("throws UNSUPPORTED_FOR_MARKDOWN for a MIME type not in the allow-list", () => {
    expect(() => assertMarkdownConvertible("image/png", 1000))
      .toThrow(expect.objectContaining({ code: "UNSUPPORTED_FOR_MARKDOWN" }));
  });

  it("throws TOO_LARGE_FOR_MARKDOWN for content over the size cap", () => {
    expect(() => assertMarkdownConvertible("application/pdf", MARKDOWN_CONVERT_MAX_BYTES + 1))
      .toThrow(expect.objectContaining({ code: "TOO_LARGE_FOR_MARKDOWN" }));
  });

  it("does not throw exactly at the size cap", () => {
    expect(() => assertMarkdownConvertible("application/pdf", MARKDOWN_CONVERT_MAX_BYTES)).not.toThrow();
  });
});

describe("convertToMarkdown", () => {
  it("returns the converted Markdown on success", async () => {
    const toMarkdown = vi.fn(async () => (
      { id: "1", name: "doc.pdf", mimeType: "application/pdf", format: "markdown" as const, tokens: 42, data: "# Doc" }
    ));
    const result = await convertToMarkdown(fakeAi(toMarkdown), "doc.pdf", "application/pdf", new ArrayBuffer(4));
    expect(result).toBe("# Doc");
    expect(toMarkdown).toHaveBeenCalledWith({ name: "doc.pdf", blob: expect.any(Blob) });
  });

  it("throws MARKDOWN_CONVERSION_FAILED when the API reports a conversion error", async () => {
    const toMarkdown = vi.fn(async () => (
      { id: "1", name: "doc.pdf", mimeType: "application/pdf", format: "error" as const, error: "corrupt file" }
    ));
    await expect(convertToMarkdown(fakeAi(toMarkdown), "doc.pdf", "application/pdf", new ArrayBuffer(4)))
      .rejects.toMatchObject({ code: "MARKDOWN_CONVERSION_FAILED" });
  });

  it("throws MARKDOWN_CONVERSION_FAILED when the API call itself throws", async () => {
    const toMarkdown = vi.fn(async () => { throw new Error("network error"); });
    await expect(convertToMarkdown(fakeAi(toMarkdown), "doc.pdf", "application/pdf", new ArrayBuffer(4)))
      .rejects.toMatchObject({ code: "MARKDOWN_CONVERSION_FAILED" });
  });
});
