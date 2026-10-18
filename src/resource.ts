/**
 * The grantable resources this gatekeeper offers, and the parsers that turn a bound resource URL
 * into the scope its gatekeeper Durable Object enforces:
 *
 * - a connected account's Fastmail mailbox, either whole or narrowed to one folder or one saved
 *   search;
 * - the same account's contacts, either all of them or one contact group.
 *
 * A resource's `urlPattern` is permanent identity (see gatekeeper-google/src/resources.ts,
 * gatekeeper-jottacloud/src/resource.ts): never change it after deploy. The narrowed bindings live
 * in the URL's hash, under the same `urlPattern`, so the whole-mailbox URL that v1 minted keeps
 * meaning exactly what it did:
 *
 *   https://api.fastmail.com/jmap/mail/account                     the whole mailbox
 *   https://api.fastmail.com/jmap/mail/account#mailbox/<id>        one folder (a JMAP Mailbox id)
 *   https://api.fastmail.com/jmap/mail/account#search/<filter>     one saved search, the filter as
 *                                                                   percent-encoded canonical JSON
 *   https://api.fastmail.com/jmap/contacts/account                 every contact
 *   https://api.fastmail.com/jmap/contacts/account#group/<id>      one contact group (the id of its
 *                                                                   group ContactCard)
 */

import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import type { JmapFilter } from "./fastmail-api";
import { FastmailError } from "./errors";

/** Host used for this gatekeeper's resource-identity URLs (the real JMAP API host). */
const RESOURCE_HOST = "api.fastmail.com";

/** The only path minted: one mailbox per connected account, narrowed (or not) by the hash. */
const RESOURCE_PATH = "/jmap/mail/account";

export const FASTMAIL_RESOURCE: SupportedResource = {
  urlPattern: `https://${RESOURCE_HOST}/jmap/mail/*`,
  title: "Fastmail Mailbox",
  description:
    "Read, search, organize, and send email through one Fastmail account you connect: the whole " +
    "mailbox, one folder, or one saved search.",
};

/** The only contacts path minted: one address book set per connected account. */
const CONTACTS_RESOURCE_PATH = "/jmap/contacts/account";

export const FASTMAIL_CONTACTS_RESOURCE: SupportedResource = {
  urlPattern: `https://${RESOURCE_HOST}/jmap/contacts/*`,
  title: "Fastmail Contacts",
  description:
    "Read, search, and edit the contacts of one Fastmail account you connect: all of them, or one contact group.",
};

export const SUPPORTED_RESOURCES: SupportedResource[] = [FASTMAIL_RESOURCE, FASTMAIL_CONTACTS_RESOURCE];

/**
 * A saved search: messages must match every field given. Text fields match as JMAP's
 * `FilterCondition` does (Fastmail's own search semantics, case-insensitive); `after`/`before`
 * bound the received time.
 */
export type FastmailSearchFilter = {
  from?: string;
  to?: string;
  subject?: string;
  /** Full-text search over headers and body. */
  text?: string;
  /** A JMAP keyword the message must carry, e.g. `"$flagged"`. */
  hasKeyword?: string;
  /** A folder (JMAP Mailbox id) the message must be in. */
  folderId?: string;
  /** Received at or after this time: a UTCDate, `YYYY-MM-DDTHH:MM:SSZ`. */
  after?: string;
  /** Received before this time: a UTCDate, `YYYY-MM-DDTHH:MM:SSZ`. */
  before?: string;
};

/** What a binding may see. */
export type FastmailScope =
  | { kind: "mailbox" }
  | { kind: "folder"; folderId: string }
  | { kind: "search"; filter: FastmailSearchFilter };

export const MAILBOX_SCOPE: FastmailScope = { kind: "mailbox" };

/** Every field a search filter may carry, in its canonical (encoding) order. */
const SEARCH_FIELDS = ["from", "to", "subject", "text", "hasKeyword", "folderId", "after", "before"] as const;
const SEARCH_TEXT_FIELDS = new Set<string>(["from", "to", "subject", "text"]);
const MAX_SEARCH_TEXT = 256;

/** A JMAP `Id` (RFC 8620 §1.2): 1-255 URL-safe base64 characters. */
const JMAP_ID = /^[A-Za-z0-9_-]{1,255}$/;
/** A JMAP keyword (RFC 8621 §4.1.1): printable ASCII except `( ) { ] % * " \`. */
const JMAP_KEYWORD = /^[\x21-\x7e]{1,255}$/;
const KEYWORD_FORBIDDEN = /[(){\]%*"\\]/;

/** Builds a resource's canonical URL for `scope`. */
export function toResourceUrl(scope: FastmailScope = MAILBOX_SCOPE): string {
  const base = `https://${RESOURCE_HOST}${RESOURCE_PATH}`;
  switch (scope.kind) {
    case "mailbox":
      return base;
    case "folder":
      return `${base}#mailbox/${validateFolderId(scope.folderId)}`;
    case "search":
      return `${base}#search/${encodeURIComponent(JSON.stringify(normalizeSearchFilter(scope.filter)))}`;
  }
}

/**
 * Parses a bound resource URL into its scope. Throws `INVALID_RESOURCE` on any URL naming a
 * different host or path, or a hash that isn't a valid folder or search scope.
 */
export function parseResourceUrl(url: string): FastmailScope {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new FastmailError("INVALID_RESOURCE", "Not a valid resource URL.");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== RESOURCE_HOST || parsed.pathname !== RESOURCE_PATH ||
      parsed.search || parsed.username || parsed.password || parsed.port) {
    throw new FastmailError(
      "INVALID_RESOURCE", `Fastmail resource URLs must be https://${RESOURCE_HOST}${RESOURCE_PATH}.`);
  }
  const hash = parsed.hash.replace(/^#/, "");
  if (!hash) return MAILBOX_SCOPE;
  if (hash.startsWith("mailbox/")) {
    return { kind: "folder", folderId: validateFolderId(hash.slice("mailbox/".length)) };
  }
  if (hash.startsWith("search/")) {
    let filter: unknown;
    try {
      filter = JSON.parse(decodeURIComponent(hash.slice("search/".length)));
    } catch {
      throw new FastmailError("INVALID_RESOURCE", "This Fastmail search scope is not valid JSON.");
    }
    return { kind: "search", filter: normalizeSearchFilter(filter) };
  }
  throw new FastmailError(
    "INVALID_RESOURCE", "A Fastmail resource can be narrowed only to #mailbox/<id> or #search/<filter>.");
}

function validateFolderId(folderId: unknown): string {
  if (typeof folderId !== "string" || !JMAP_ID.test(folderId)) {
    throw new FastmailError("INVALID_RESOURCE", "Not a valid Fastmail folder id.");
  }
  return folderId;
}

/** What a contacts binding may see. */
export type FastmailContactsScope =
  | { kind: "all" }
  | { kind: "group"; groupId: string };

export const ALL_CONTACTS_SCOPE: FastmailContactsScope = { kind: "all" };

/** Builds a contacts resource's canonical URL for `scope`. */
export function toContactsResourceUrl(scope: FastmailContactsScope = ALL_CONTACTS_SCOPE): string {
  const base = `https://${RESOURCE_HOST}${CONTACTS_RESOURCE_PATH}`;
  return scope.kind === "all" ? base : `${base}#group/${validateGroupId(scope.groupId)}`;
}

/** Whether `url` names this gatekeeper's contacts resource rather than the mailbox. */
export function isContactsResourceUrl(url: string): boolean {
  try {
    return new URL(url).pathname.startsWith("/jmap/contacts/");
  } catch {
    return false;
  }
}

/**
 * Parses a bound contacts resource URL into its scope. Throws `INVALID_RESOURCE` on any URL naming a
 * different host or path, or a hash that isn't a valid group scope.
 */
export function parseContactsResourceUrl(url: string): FastmailContactsScope {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new FastmailError("INVALID_RESOURCE", "Not a valid resource URL.");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== RESOURCE_HOST ||
      parsed.pathname !== CONTACTS_RESOURCE_PATH || parsed.search || parsed.username || parsed.password ||
      parsed.port) {
    throw new FastmailError(
      "INVALID_RESOURCE", `Fastmail contacts resource URLs must be https://${RESOURCE_HOST}${CONTACTS_RESOURCE_PATH}.`);
  }
  const hash = parsed.hash.replace(/^#/, "");
  if (!hash) return ALL_CONTACTS_SCOPE;
  if (hash.startsWith("group/")) return { kind: "group", groupId: validateGroupId(hash.slice("group/".length)) };
  throw new FastmailError("INVALID_RESOURCE", "Fastmail contacts can be narrowed only to #group/<id>.");
}

function validateGroupId(groupId: unknown): string {
  if (typeof groupId !== "string" || !JMAP_ID.test(groupId)) {
    throw new FastmailError("INVALID_RESOURCE", "Not a valid Fastmail contact group id.");
  }
  return groupId;
}

/**
 * Validates a search filter and returns its canonical form: known fields only, in a fixed order,
 * text trimmed, dates as UTCDates. At least one field must be set, so a search scope can never
 * silently admit the whole mailbox.
 */
export function normalizeSearchFilter(input: unknown): FastmailSearchFilter {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new FastmailError("INVALID_RESOURCE", "A Fastmail search scope must be an object.");
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(SEARCH_FIELDS as readonly string[]).includes(key)) {
      throw new FastmailError("INVALID_RESOURCE", `Unknown Fastmail search field "${key}".`);
    }
  }
  const filter: FastmailSearchFilter = {};
  for (const key of SEARCH_FIELDS) {
    const raw = record[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "string") {
      throw new FastmailError("INVALID_RESOURCE", `Fastmail search field "${key}" must be a string.`);
    }
    const value = raw.trim();
    if (!value) continue;
    if (SEARCH_TEXT_FIELDS.has(key)) {
      filter[key as "from" | "to" | "subject" | "text"] = searchText(key, value);
    } else if (key === "hasKeyword") {
      filter.hasKeyword = searchKeyword(value);
    } else if (key === "folderId") {
      filter.folderId = validateFolderId(value);
    } else {
      filter[key as "after" | "before"] = toUtcDate(value, key);
    }
  }
  if (Object.keys(filter).length === 0) {
    throw new FastmailError("INVALID_RESOURCE", "A Fastmail search scope needs at least one condition.");
  }
  if (filter.after && filter.before && filter.after >= filter.before) {
    throw new FastmailError("INVALID_RESOURCE", "A Fastmail search scope's `after` must be before its `before`.");
  }
  return filter;
}

/** A search text field, at most `MAX_SEARCH_TEXT` characters. */
function searchText(field: string, value: string): string {
  if (value.length > MAX_SEARCH_TEXT) {
    throw new FastmailError("INVALID_RESOURCE", `Fastmail search field "${field}" is too long.`);
  }
  return value;
}

/** A JMAP keyword (RFC 8621 §4.1.1). */
function searchKeyword(value: string): string {
  if (!JMAP_KEYWORD.test(value) || KEYWORD_FORBIDDEN.test(value)) {
    throw new FastmailError("INVALID_RESOURCE", "Not a valid JMAP keyword.");
  }
  return value;
}

/** A date (`YYYY-MM-DD`) or date-time, as a JMAP UTCDate. */
function toUtcDate(value: string, field: string): string {
  const time = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : Date.parse(value);
  if (Number.isNaN(time) || !/^\d{4}-\d{2}-\d{2}/.test(value)) {
    throw new FastmailError("INVALID_RESOURCE", `Fastmail search field "${field}" must be a date (YYYY-MM-DD).`);
  }
  return new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z");
}

const AGENT_SEARCH_TEXT_FIELDS = ["text", "from", "to", "subject"] as const;
const AGENT_SEARCH_BOOLEAN_FIELDS = ["unread", "flagged", "hasAttachment"] as const;
const AGENT_SEARCH_FIELDS: readonly string[] = [
  ...AGENT_SEARCH_TEXT_FIELDS, ...AGENT_SEARCH_BOOLEAN_FIELDS, "hasKeyword", "notKeyword", "after", "before",
];

/**
 * Validates what an agent passed to `searchThreads()`/`searchMessages()` and returns the JMAP
 * `Email/query` filter it stands for. A string is a full-text search; an object's fields must all
 * match. Conditions that would share one `FilterCondition` key (e.g. `unread` and
 * `notKeyword: "$seen"`) are ANDed in an operator instead of overwriting each other. At least one
 * condition is required.
 */
export function normalizeSearch(input: unknown): JmapFilter {
  const record: Record<string, unknown> = typeof input === "string" ? { text: input } : input as Record<string, unknown>;
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw new FastmailError("INVALID_RESOURCE", "A Fastmail search must be a string or an object.");
  }
  for (const key of Object.keys(record)) {
    if (!AGENT_SEARCH_FIELDS.includes(key)) {
      throw new FastmailError("INVALID_RESOURCE", `Unknown Fastmail search field "${key}".`);
    }
  }
  const entries: [string, string | boolean][] = [];
  for (const key of AGENT_SEARCH_TEXT_FIELDS) {
    const raw = record[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "string") {
      throw new FastmailError("INVALID_RESOURCE", `Fastmail search field "${key}" must be a string.`);
    }
    const value = raw.trim();
    if (value) entries.push([key, searchText(key, value)]);
  }
  for (const key of ["hasKeyword", "notKeyword"] as const) {
    const raw = record[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "string") {
      throw new FastmailError("INVALID_RESOURCE", `Fastmail search field "${key}" must be a string.`);
    }
    entries.push([key, searchKeyword(raw.trim())]);
  }
  for (const key of ["after", "before"] as const) {
    const raw = record[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "string") {
      throw new FastmailError("INVALID_RESOURCE", `Fastmail search field "${key}" must be a string.`);
    }
    entries.push([key, toUtcDate(raw.trim(), key)]);
  }
  for (const key of AGENT_SEARCH_BOOLEAN_FIELDS) {
    const raw = record[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "boolean") {
      throw new FastmailError("INVALID_RESOURCE", `Fastmail search field "${key}" must be true or false.`);
    }
    if (key === "hasAttachment") entries.push(["hasAttachment", raw]);
    else {
      const keyword = key === "unread" ? "$seen" : "$flagged";
      // Unread means not seen; flagged means has the flag.
      const present = key === "unread" ? !raw : raw;
      entries.push([present ? "hasKeyword" : "notKeyword", keyword]);
    }
  }
  if (entries.length === 0) {
    throw new FastmailError("INVALID_RESOURCE", "A Fastmail search needs at least one condition.");
  }
  const after = entries.find(([key]) => key === "after")?.[1];
  const before = entries.find(([key]) => key === "before")?.[1];
  if (typeof after === "string" && typeof before === "string" && after >= before) {
    throw new FastmailError("INVALID_RESOURCE", "A Fastmail search's `after` must be before its `before`.");
  }

  const base: Record<string, unknown> = {};
  const collisions: JmapFilter[] = [];
  for (const [key, value] of entries) {
    if (!(key in base)) base[key] = value;
    else if (base[key] !== value) collisions.push({ [key]: value });
  }
  return collisions.length === 0 ? base : { operator: "AND", conditions: [base, ...collisions] };
}

/** The JMAP `FilterCondition` a search scope stands for (RFC 8621 §4.4.1). */
export function searchFilterCondition(filter: FastmailSearchFilter): Record<string, string> {
  const condition: Record<string, string> = {};
  if (filter.from) condition.from = filter.from;
  if (filter.to) condition.to = filter.to;
  if (filter.subject) condition.subject = filter.subject;
  if (filter.text) condition.text = filter.text;
  if (filter.hasKeyword) condition.hasKeyword = filter.hasKeyword;
  if (filter.folderId) condition.inMailbox = filter.folderId;
  if (filter.after) condition.after = filter.after;
  if (filter.before) condition.before = filter.before;
  return condition;
}

/** A one-line, human-readable form of a search scope, for titles and approvals. */
export function describeSearchFilter(filter: FastmailSearchFilter, folderName?: string): string {
  const parts: string[] = [];
  if (filter.from) parts.push(`from "${filter.from}"`);
  if (filter.to) parts.push(`to "${filter.to}"`);
  if (filter.subject) parts.push(`subject "${filter.subject}"`);
  if (filter.text) parts.push(`containing "${filter.text}"`);
  if (filter.hasKeyword) parts.push(`with keyword ${filter.hasKeyword}`);
  if (filter.folderId) parts.push(`in folder "${folderName ?? filter.folderId}"`);
  if (filter.after) parts.push(`received from ${filter.after.slice(0, 10)}`);
  if (filter.before) parts.push(`received before ${filter.before.slice(0, 10)}`);
  return parts.join(", ");
}
