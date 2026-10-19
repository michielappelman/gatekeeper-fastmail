/**
 * Internal JMAP (RFC 8620 core + RFC 8621 Mail) wire types. Nothing here is exposed to agents — see
 * `./types.d.ts` for the agent-facing API. Field names mirror the JMAP spec exactly (camelCase,
 * server-assigned ids), so this file trades our own naming conventions for a direct mapping to
 * https://www.fastmail.com/dev/ and https://jmap.io (RFC 8620/8621) — re-verify against those before
 * relying on any specific capability URN or limit below; they were not fetched directly from a live
 * session while building this gatekeeper.
 */

import type { BulkHeaders } from "./bulk";

export const JMAP_CORE_CAPABILITY = "urn:ietf:params:jmap:core";
export const JMAP_MAIL_CAPABILITY = "urn:ietf:params:jmap:mail";
export const JMAP_SUBMISSION_CAPABILITY = "urn:ietf:params:jmap:submission";
/** JMAP for Contacts (RFC 9610): AddressBook and ContactCard. Fastmail lists it at
 * https://www.fastmail.com/dev/ as an API-token scope of its own ("Contacts"). */
export const JMAP_CONTACTS_CAPABILITY = "urn:ietf:params:jmap:contacts";
/** Fastmail's Masked Email extension (https://www.fastmail.com/dev/maskedemail): `MaskedEmail/get`
 * and `MaskedEmail/set`. A separate API-token scope ("Masked Email"). */
export const MASKED_EMAIL_CAPABILITY = "https://www.fastmail.com/dev/maskedemail";

/** The JMAP session resource, `GET <sessionUrl>` (Fastmail: `https://api.fastmail.com/jmap/session`). */
export type JmapSessionResource = {
  /** The login the token belongs to; Fastmail uses the account's primary address. */
  username?: string;
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
  /** Set for a part the HTML body shows inline, referenced as `cid:<cid>`. */
  cid?: string | null;
  disposition?: string | null;
};

/** One JMAP Email object (`Email/get`), narrowed to the properties this gatekeeper requests. */
export type JmapEmailObject = BulkHeaders & {
  id: string;
  threadId: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  from: JmapEmailAddress[] | null;
  to: JmapEmailAddress[] | null;
  cc: JmapEmailAddress[] | null;
  /** Only when requested: a draft's Bcc. */
  bcc?: JmapEmailAddress[] | null;
  subject: string | null;
  receivedAt: string;
  /** The `Date` header: when the sender says it was sent; only when requested. */
  sentAt?: string | null;
  preview: string;
  textBody?: { partId: string | null; type?: string }[];
  htmlBody?: { partId: string | null; type?: string }[];
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

/** A JSContact `Name` (RFC 9553 §2.2.1). */
export type JsContactName = {
  full?: string;
  components?: { kind: string; value: string }[];
};

/**
 * One JMAP ContactCard (RFC 9610 §3), a JSContact Card (RFC 9553). Only the properties this
 * gatekeeper requests; every map is keyed by a card-local id. A contact group is a card with
 * `kind: "group"` whose `members` set holds the `uid`s of the cards in it.
 */
export type JmapContactCard = {
  id: string;
  uid: string;
  kind?: string;
  name?: JsContactName;
  nicknames?: Record<string, { name: string }>;
  emails?: Record<string, { address: string; contexts?: Record<string, boolean>; pref?: number; label?: string }>;
  phones?: Record<string, {
    number: string; features?: Record<string, boolean>; contexts?: Record<string, boolean>; pref?: number;
    label?: string;
  }>;
  organizations?: Record<string, { name?: string; units?: { name: string }[] }>;
  titles?: Record<string, { name: string; kind?: string }>;
  addresses?: Record<string, {
    full?: string; components?: { kind: string; value: string }[]; contexts?: Record<string, boolean>;
  }>;
  onlineServices?: Record<string, { uri?: string; user?: string; service?: string }>;
  anniversaries?: Record<string, { kind: string; date: { "@type"?: string; year?: number; month?: number; day?: number; utc?: string } }>;
  notes?: Record<string, { note: string }>;
  members?: Record<string, boolean>;
};

/** One Fastmail MaskedEmail object. `deleted` addresses reject mail; `pending` ones are deleted by
 * Fastmail unless they receive mail within 24 hours. */
export type JmapMaskedEmail = {
  id: string;
  email: string;
  state: "pending" | "enabled" | "disabled" | "deleted";
  forDomain?: string | null;
  description?: string | null;
  createdAt?: string | null;
  lastMessageAt?: string | null;
};
