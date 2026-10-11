/**
 * Mailing-list and bulk-mail signals, read from headers Fastmail parses for us in the same
 * `Email/get` (RFC 8621 §4.1.2 `header:{name}:{form}` properties), so no extra request per message.
 */

import type { FastmailBulkSignals } from "./types";

/** The header properties `Email/get` requests for these signals. */
export const BULK_HEADER_PROPERTIES = [
  "header:List-Id:asText",
  "header:List-Unsubscribe:asURLs",
  "header:List-Unsubscribe-Post:asText",
  "header:Precedence:asText",
  "header:Auto-Submitted:asText",
] as const;

/** An `Email/get` result carrying the properties above. */
export type BulkHeaders = Partial<Record<(typeof BULK_HEADER_PROPERTIES)[number], unknown>>;

const BULK_PRECEDENCE = new Set(["bulk", "list", "junk"]);

/** The signals an email's headers carry; `isBulk` is true for any mailing-list or bulk marker. */
export function bulkSignals(email: BulkHeaders): FastmailBulkSignals {
  const signals: FastmailBulkSignals = { isBulk: false };
  const listId = text(email["header:List-Id:asText"]);
  if (listId) {
    // "Newsletter <news.example.com>": the id is the part in angle brackets (RFC 2919).
    signals.listId = /<([^>]+)>/.exec(listId)?.[1]?.trim() ?? listId;
  }
  const urls = email["header:List-Unsubscribe:asURLs"];
  if (Array.isArray(urls)) {
    const unsubscribe = urls.filter((url): url is string => typeof url === "string" && /^(mailto|https?):/i.test(url));
    if (unsubscribe.length > 0) signals.unsubscribe = unsubscribe;
  }
  if (/List-Unsubscribe=One-Click/i.test(text(email["header:List-Unsubscribe-Post:asText"]) ?? "")) {
    signals.oneClickUnsubscribe = true;
  }
  const precedence = text(email["header:Precedence:asText"])?.toLowerCase();
  if (precedence) signals.precedence = precedence;
  const autoSubmitted = text(email["header:Auto-Submitted:asText"])?.toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") signals.autoSubmitted = autoSubmitted;
  signals.isBulk = Boolean(signals.listId || signals.unsubscribe || (precedence && BULK_PRECEDENCE.has(precedence)));
  return signals;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
