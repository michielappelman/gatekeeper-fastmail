/**
 * Internal JMAP (RFC 8620 core + RFC 8621 Mail) wire types. Nothing here is exposed to agents — see
 * `./types.d.ts` for the agent-facing API. Field names mirror the JMAP spec exactly (camelCase,
 * server-assigned ids), so this file trades our own naming conventions for a direct mapping to
 * https://www.fastmail.com/dev/ and https://jmap.io (RFC 8620/8621) — re-verify against those before
 * relying on any specific capability URN or limit below; they were not fetched directly from a live
 * session while building this gatekeeper.
 */

export const JMAP_CORE_CAPABILITY = "urn:ietf:params:jmap:core";
export const JMAP_MAIL_CAPABILITY = "urn:ietf:params:jmap:mail";
export const JMAP_SUBMISSION_CAPABILITY = "urn:ietf:params:jmap:submission";

/** The JMAP session resource, `GET <sessionUrl>` (Fastmail: `https://api.fastmail.com/jmap/session`). */
export type JmapSessionResource = {
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  accounts: Record<string, { accountCapabilities: Record<string, unknown> }>;
  primaryAccounts: Record<string, string>;
};

/** One JMAP Mailbox object (`Mailbox/get`) — Fastmail's nearest equivalent to an IMAP folder. */
export type JmapMailboxObject = {
  id: string;
  name: string;
  parentId: string | null;
  role: string | null;
  totalEmails: number;
  unreadEmails: number;
};

/** One JMAP EmailAddress object, used in `from`/`to`/`cc`/`bcc`. */
export type JmapEmailAddress = { email: string; name?: string | null };

/** One JMAP Email object's `bodyValue` entry, keyed by `bodyValues[partId]`. */
export type JmapBodyValue = { value: string; isTruncated?: boolean };

/** One JMAP Email object's `attachments[]` entry. */
export type JmapAttachment = {
  blobId: string;
  type: string;
  name: string | null;
  size: number;
};

/** One JMAP Email object (`Email/get`), narrowed to the properties this gatekeeper requests. */
export type JmapEmailObject = {
  id: string;
  threadId: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  from: JmapEmailAddress[] | null;
  to: JmapEmailAddress[] | null;
  cc: JmapEmailAddress[] | null;
  subject: string | null;
  receivedAt: string;
  preview: string;
  textBody?: { partId: string | null }[];
  htmlBody?: { partId: string | null }[];
  bodyValues?: Record<string, JmapBodyValue>;
  attachments?: JmapAttachment[];
  /** The `Message-ID` header's ids, without angle brackets; only when requested. */
  messageId?: string[] | null;
  inReplyTo?: string[] | null;
  references?: string[] | null;
  replyTo?: JmapEmailAddress[] | null;
};

/** A JMAP `/api/` request's single method call: `[name, arguments, callId]`. */
export type JmapMethodCall = [name: string, args: Record<string, unknown>, callId: string];

/** A JMAP `/api/` response's single method response: `[name, result, callId]`. */
export type JmapMethodResponse = [name: string, result: Record<string, unknown>, callId: string];

export type JmapRequestBody = {
  using: string[];
  methodCalls: JmapMethodCall[];
};

export type JmapResponseBody = {
  methodResponses: JmapMethodResponse[];
};

/** The `error` method response's `type` (RFC 8620 §3.6.2), when a call fails server-side. */
export type JmapMethodError = { type: string; description?: string };
