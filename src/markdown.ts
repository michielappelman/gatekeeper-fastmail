import { FastmailError } from "./errors";

/**
 * MIME types `env.WORKERS_AI.toMarkdown()` can convert for free (no Workers AI model usage) --
 * HTML, PDF, and common office/document formats, mirroring the Workshop's `webFetch` agent tool
 * (`cloudflare-os/packages/workshop-backend/src/web-fetch.ts`). Image MIME types are intentionally
 * excluded: image conversion uses paid Workers AI models.
 */
export const MARKDOWN_CONVERTIBLE_MIME_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "application/pdf",
  "application/xml",
  "text/xml",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",       // .xlsx
  "application/vnd.ms-excel",                                                // .xls
  "application/vnd.ms-excel.sheet.macroenabled.12",                          // .xlsm
  "application/vnd.ms-excel.sheet.binary.macroenabled.12",                   // .xlsb
  "application/vnd.oasis.opendocument.spreadsheet",                          // .ods
  "application/vnd.oasis.opendocument.text",                                 // .odt
  "application/vnd.apple.numbers",                                           // .numbers
]);

/** Content above this size is rejected before it is downloaded or sent for conversion. Cloudflare
 * documents no hard byte-size limit for `toMarkdown()` itself (it parses PDFs page-by-page on its
 * own side), and this call is I/O-bound for this Worker rather than CPU-bound, so this exists as a
 * sane ceiling rather than a workaround for a known constraint -- sized to comfortably cover
 * real-world PDFs (a few MB, up to ~10MB) with headroom. */
export const MARKDOWN_CONVERT_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB

/**
 * Throws `UNSUPPORTED_FOR_MARKDOWN`/`TOO_LARGE_FOR_MARKDOWN` before any content is downloaded or
 * sent for conversion, from an attachment's own metadata (`mimeType`/`size`).
 */
export function assertMarkdownConvertible(mimeType: string, size: number): void {
  if (!MARKDOWN_CONVERTIBLE_MIME_TYPES.has(mimeType)) {
    throw new FastmailError(
      "UNSUPPORTED_FOR_MARKDOWN",
      `This attachment's recorded type (${mimeType}) cannot be converted to Markdown.`);
  }
  if (size > MARKDOWN_CONVERT_MAX_BYTES) {
    throw new FastmailError(
      "TOO_LARGE_FOR_MARKDOWN",
      `This attachment is ${size} bytes, over the ${MARKDOWN_CONVERT_MAX_BYTES}-byte Markdown ` +
      "conversion limit.");
  }
}

/**
 * Converts `content` to Markdown via Cloudflare Workers AI -- the same `toMarkdown()` mechanism
 * the Workshop's `webFetch` agent tool uses for fetched web content.
 */
export async function convertToMarkdown(
  ai: Ai, name: string, mimeType: string, content: ArrayBuffer,
): Promise<string> {
  let result: ConversionResponse;
  try {
    result = await ai.toMarkdown({ name, blob: new Blob([content], { type: mimeType }) });
  } catch (cause) {
    throw new FastmailError("MARKDOWN_CONVERSION_FAILED", "Markdown conversion failed.", { cause });
  }
  if (result.format === "error") {
    throw new FastmailError(
      "MARKDOWN_CONVERSION_FAILED", `Markdown conversion failed: ${result.error}`);
  }
  return result.data;
}
