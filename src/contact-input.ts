/**
 * Agent-facing contact input (`FastmailContactInput`) → JSContact (RFC 9553) card properties, as
 * `ContactCard/set` writes them: whole properties for a creation, and for an update a patch that
 * replaces each property given (`null` removes one).
 */

import { FastmailError } from "./errors";
import type { FastmailContactInput } from "./types";

const MAX_TEXT = 1000;
const MAX_NOTES = 10_000;
const MAX_ITEMS = 50;

const CONTEXTS: Record<string, true> = { work: true, private: true };
const PHONE_FEATURES: Record<string, true> = {
  mobile: true, voice: true, fax: true, text: true, pager: true, video: true, textphone: true, "main-number": true,
};

/** The card properties `input` writes; every key present in `input` maps to one, even to clear it. */
type CardProperties = Record<string, unknown>;

function invalid(message: string): FastmailError {
  return new FastmailError("INVALID_RESOURCE", message);
}

function text(value: unknown, field: string, max = MAX_TEXT): string {
  if (typeof value !== "string") throw invalid(`Contact field "${field}" must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw invalid(`Contact field "${field}" is too long.`);
  return trimmed;
}

function list<T>(value: unknown, field: string, item: (entry: unknown) => T): T[] {
  if (!Array.isArray(value)) throw invalid(`Contact field "${field}" must be a list.`);
  if (value.length > MAX_ITEMS) throw invalid(`Contact field "${field}" has too many entries.`);
  return value.map(item);
}

/** A JSContact id-keyed map of `items`, in order, or `null` (remove the property) when empty. */
function idMap(items: object[]): Record<string, object> | null {
  return items.length > 0 ? Object.fromEntries(items.map((value, index) => [`k${index + 1}`, value])) : null;
}

/** A label of known contexts (and, for phones, features) becomes those; anything else a label. */
function labelProperties(label: string | undefined, features: Record<string, true> = {}): object {
  if (!label) return {};
  const tokens = label.split(",").map(token => token.trim().toLowerCase()).filter(Boolean);
  if (tokens.length === 0 || !tokens.every(token => CONTEXTS[token] || features[token])) return { label };
  const contexts = tokens.filter(token => CONTEXTS[token]);
  const featureTokens = tokens.filter(token => features[token]);
  return {
    ...contexts.length > 0 ? { contexts: Object.fromEntries(contexts.map(token => [token, true])) } : {},
    ...featureTokens.length > 0 ? { features: Object.fromEntries(featureTokens.map(token => [token, true])) } : {},
  };
}

function entryObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw invalid(`Each "${field}" entry must be an object.`);
  return value as Record<string, unknown>;
}

function optionalLabel(entry: Record<string, unknown>, field: string): string | undefined {
  return entry.label === undefined || entry.label === null ? undefined : text(entry.label, `${field}.label`) || undefined;
}

const BIRTHDAY = /^(?:(\d{4})|-)-(\d{2})-(\d{2})$/;

function birthday(value: unknown): object | null {
  if (value === null) return null;
  const raw = text(value, "birthday");
  const match = BIRTHDAY.exec(raw);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  if (!match || month < 1 || month > 12 || day < 1 || day > 31) {
    throw invalid('Contact field "birthday" must be YYYY-MM-DD or --MM-DD.');
  }
  return {
    b1: {
      kind: "birth",
      date: { "@type": "PartialDate", ...match[1] ? { year: Number(match[1]) } : {}, month, day },
    },
  };
}

/** The card properties for `input`. `create` also requires something to identify the contact by. */
export function cardProperties(input: FastmailContactInput, { create }: { create: boolean }): CardProperties {
  if (typeof input !== "object" || input === null) throw invalid("A contact must be an object.");
  const props: CardProperties = {};

  if (input.kind !== undefined) {
    if (input.kind !== "individual" && input.kind !== "org") throw invalid('Contact "kind" must be "individual" or "org".');
    props.kind = input.kind;
  } else if (create) {
    props.kind = "individual";
  }

  if (input.name !== undefined || input.givenName !== undefined || input.surname !== undefined) {
    const full = input.name === undefined || input.name === null ? "" : text(input.name, "name");
    const components = [
      ["given", input.givenName === undefined || input.givenName === null ? "" : text(input.givenName, "givenName")],
      ["surname", input.surname === undefined || input.surname === null ? "" : text(input.surname, "surname")],
    ].filter(([, value]) => value).map(([kind, value]) => ({ kind, value }));
    props.name = full || components.length > 0
      ? { ...full ? { full } : {}, ...components.length > 0 ? { components } : {} }
      : null;
  }
  if (input.nicknames !== undefined) {
    props.nicknames = idMap(list(input.nicknames, "nicknames", name => text(name, "nicknames")).filter(Boolean)
      .map(name => ({ name })));
  }
  if (input.emails !== undefined) {
    props.emails = idMap(list(input.emails, "emails", raw => {
      const entry = entryObject(raw, "emails");
      const address = text(entry.address, "emails.address");
      if (!/^[^\s@]+@[^\s@]+$/.test(address)) throw invalid(`"${address}" is not an email address.`);
      return { address, ...labelProperties(optionalLabel(entry, "emails")) };
    }).map((email, index) => index < 100 ? { ...email, pref: index + 1 } : email));
  }
  if (input.phones !== undefined) {
    props.phones = idMap(list(input.phones, "phones", raw => {
      const entry = entryObject(raw, "phones");
      const number = text(entry.number, "phones.number");
      if (!number) throw invalid("A phone entry needs a number.");
      return { number, ...labelProperties(optionalLabel(entry, "phones"), PHONE_FEATURES) };
    }).map((phone, index) => index < 100 ? { ...phone, pref: index + 1 } : phone));
  }
  if (input.organizations !== undefined) {
    props.organizations = idMap(list(input.organizations, "organizations", org => text(org, "organizations"))
      .filter(Boolean).map(org => {
        const [name, ...units] = org.split(" / ").map(part => part.trim()).filter(Boolean);
        return { name, ...units.length > 0 ? { units: units.map(unit => ({ name: unit })) } : {} };
      }));
  }
  if (input.titles !== undefined) {
    props.titles = idMap(list(input.titles, "titles", title => text(title, "titles")).filter(Boolean)
      .map(name => ({ name })));
  }
  if (input.addresses !== undefined) {
    props.addresses = idMap(list(input.addresses, "addresses", line => text(line, "addresses")).filter(Boolean)
      .map(full => ({ full })));
  }
  if (input.online !== undefined) {
    props.onlineServices = idMap(list(input.online, "online", value => text(value, "online")).filter(Boolean)
      .map(value => /^[a-z][a-z0-9+.-]*:/i.test(value) ? { uri: value } : { user: value }));
  }
  if (input.birthday !== undefined) props.anniversaries = birthday(input.birthday);
  if (input.notes !== undefined) {
    const note = input.notes === null ? "" : text(input.notes, "notes", MAX_NOTES);
    props.notes = note ? { n1: { note } } : null;
  }

  if (create) {
    if (!props.name && !props.emails && !props.phones && !props.organizations) {
      throw invalid("A new contact needs a name, an email address, a phone number or an organization.");
    }
    for (const key of Object.keys(props)) if (props[key] === null) delete props[key];
  } else if (Object.keys(props).length === 0) {
    throw invalid("Give at least one contact field to change.");
  }
  return props;
}
