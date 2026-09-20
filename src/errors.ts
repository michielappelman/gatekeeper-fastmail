/**
 * Stable error codes the rest of the gatekeeper can branch on, independent of Fastmail's own HTTP
 * statuses or JMAP `type` URIs. Every call into `./fastmail-api.ts` throws a `FastmailError`, never
 * a raw `Response` or fetch failure.
 */
export type FastmailErrorCode =
  | "AUTH_REQUIRED"
  | "AUTH_EXPIRED"
  | "SUBMISSION_NOT_AUTHORIZED"
  | "RESOURCE_NOT_FOUND"
  | "INVALID_RESOURCE"
  | "RATE_LIMITED"
  | "UPSTREAM_UNAVAILABLE"
  | "UNSUPPORTED_FOR_MARKDOWN"
  | "TOO_LARGE_FOR_MARKDOWN"
  | "MARKDOWN_CONVERSION_FAILED";

export class FastmailError extends Error {
  constructor(readonly code: FastmailErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FastmailError";
  }
}

/** Classifies a Fastmail JMAP HTTP response status into a stable error code. */
export function errorForStatus(status: number): FastmailError {
  if (status === 401) {
    return new FastmailError("AUTH_EXPIRED", "Fastmail rejected the current API token.");
  }
  if (status === 403) {
    return new FastmailError(
      "SUBMISSION_NOT_AUTHORIZED", "Fastmail denied this request (insufficient token scope).");
  }
  if (status === 404) {
    return new FastmailError("RESOURCE_NOT_FOUND", "The requested Fastmail resource was not found.");
  }
  if (status === 429) {
    return new FastmailError("RATE_LIMITED", "Fastmail is rate-limiting this account.");
  }
  if (status >= 500) {
    return new FastmailError("UPSTREAM_UNAVAILABLE", `Fastmail returned a server error (${status}).`);
  }
  return new FastmailError("UPSTREAM_UNAVAILABLE", `Fastmail request failed with status ${status}.`);
}
