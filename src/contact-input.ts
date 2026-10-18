/**
 * Agent-facing contact input → JSContact (RFC 9553) card properties, as `ContactCard/set` writes them.
 *
 * - `cardProperties()` turns a `FastmailContactInput` into the whole properties of a new card.
 * - `validateChanges()` checks a `FastmailContactChanges` when it is staged; `planContactPatch()`
 *   resolves the validated changes against the card as it is at apply time, into a PatchObject that
 *   touches only the entries and name components concerned.
 */

import { FastmailError } from "./errors";
import type { JmapContactCard } from "./fastmail-types";
import type {
  FastmailContactChanges,
  FastmailContactEmail,
  FastmailContactInput,
  FastmailContactListChange,
  FastmailContactPhone,
} from "./types";

const MAX_TEXT = 1000;
const MAX_NOTES = 10_000;
const MAX_ITEMS = 50;

const CONTEXTS: Record<string, true> = { work: true, private: true };
const PHONE_FEATURES: Record<string, true> = {
  mobile: true, voice: true, fax: true, text: true, pager: true, video: true, textphone: true, "main-number": true,
};

/** The card properties a contact input writes. */
type CardProperties = Record<string, unknown>;
type MapEntry<M> = M extends Record<string, infer E> ? E : never;
type EmailEntry = MapEntry<NonNullable<JmapContactCard["emails"]>>;
type PhoneEntry = MapEntry<NonNullable<JmapContactCard["phones"]>>;
type OrganizationEntry = MapEntry<NonNullable<JmapContactCard["organizations"]>>;
type TitleEntry = MapEntry<NonNullable<JmapContactCard["titles"]>>;
type AddressEntry = MapEntry<NonNullable<JmapContactCard["addresses"]>>;
type OnlineEntry = MapEntry<NonNullable<JmapContactCard["onlineServices"]>>;
type NicknameEntry = MapEntry<NonNullable<JmapContactCard["nicknames"]>>;

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
function labelProperties(
  label: string | undefined, features: Record<string, true> = {},
): { label?: string; contexts?: Record<string, boolean>; features?: Record<string, boolean> } {
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
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(`Each "${field}" entry must be an object.`);
  }
  return value as Record<string, unknown>;
}

function optionalLabel(entry: Record<string, unknown>, field: string): string | undefined {
  return entry.label === undefined || entry.label === null ? undefined : text(entry.label, `${field}.label`) || undefined;
}

// ---------------------------------------------------------------------------
// What an entry looks like to the agent: `FastmailContact` strings, also used to match removals

/** `"Acme / Research"`: the organization name with its units. */
export function organizationLine(org: OrganizationEntry): string | undefined {
  const parts = [org.name, ...(org.units ?? []).map(unit => unit.name)].filter((part): part is string => !!part);
  return parts.length > 0 ? parts.join(" / ") : undefined;
}

export function addressLine(address: AddressEntry): string | undefined {
  const line = address.full ||
    (address.components ?? []).filter(component => component.kind !== "separator")
      .map(component => component.value).join(", ");
  return line || undefined;
}

export function onlineValue(service: OnlineEntry): string | undefined {
  const value = service.uri ?? service.user;
  return value ? (service.service && !service.uri ? `${service.service}: ${value}` : value) : undefined;
}

/** Phone numbers compare by their digits and a leading `+`. */
function phoneKey(number: string): string {
  return `${number.trim().startsWith("+") ? "+" : ""}${number.replace(/\D/g, "")}`;
}

// ---------------------------------------------------------------------------
// The list properties

/**
 * How one list property (`emails`, `titles`, ...) is validated, written and matched. `V` is the
 * agent-facing value; `E` the JSContact entry.
 */
type ListSpec<V, E extends object> = {
  /** The agent-facing field. */
  field: string;
  /** The card property it lives in. */
  prop: string;
  entries(card: JmapContactCard): Record<string, E> | undefined;
  parse(raw: unknown): V;
  toEntry(value: V): E;
  /** What identifies an entry for removal and for skipping a value that is already there. */
  keyOfEntry(entry: E): string | undefined;
  keyOfRemoval(removal: string): string;
  /** Emails and phones are ordered by `pref`. */
  ordered: boolean;
};

const EMAIL: ListSpec<FastmailContactEmail, EmailEntry> = {
  field: "emails",
  prop: "emails",
  entries: card => card.emails,
  parse(raw) {
    const entry = entryObject(raw, "emails");
    const address = text(entry.address, "emails.address");
    if (!/^[^\s@]+@[^\s@]+$/.test(address)) throw invalid(`"${address}" is not an email address.`);
    const label = optionalLabel(entry, "emails");
    return label ? { address, label } : { address };
  },
  toEntry: email => ({ address: email.address, ...labelProperties(email.label) }),
  keyOfEntry: entry => entry.address.toLowerCase(),
  keyOfRemoval: address => address.toLowerCase(),
  ordered: true,
};

const PHONE: ListSpec<FastmailContactPhone, PhoneEntry> = {
  field: "phones",
  prop: "phones",
  entries: card => card.phones,
  parse(raw) {
    const entry = entryObject(raw, "phones");
    const number = text(entry.number, "phones.number");
    if (!number) throw invalid("A phone entry needs a number.");
    const label = optionalLabel(entry, "phones");
    return label ? { number, label } : { number };
  },
  toEntry: phone => ({ number: phone.number, ...labelProperties(phone.label, PHONE_FEATURES) }),
  keyOfEntry: entry => phoneKey(entry.number),
  keyOfRemoval: phoneKey,
  ordered: true,
};

function stringValue(field: string): (raw: unknown) => string {
  return raw => {
    const value = text(raw, field);
    if (!value) throw invalid(`Contact field "${field}" can't hold an empty value.`);
    return value;
  };
}

const identity = (value: string) => value;

const NICKNAME: ListSpec<string, NicknameEntry> = {
  field: "nicknames", prop: "nicknames", entries: card => card.nicknames, parse: stringValue("nicknames"),
  toEntry: name => ({ name }), keyOfEntry: entry => entry.name, keyOfRemoval: identity, ordered: false,
};

const ORGANIZATION: ListSpec<string, OrganizationEntry> = {
  field: "organizations", prop: "organizations", entries: card => card.organizations,
  parse: stringValue("organizations"),
  toEntry(org) {
    const [name, ...units] = org.split(" / ").map(part => part.trim()).filter(Boolean);
    return { name, ...units.length > 0 ? { units: units.map(unit => ({ name: unit })) } : {} };
  },
  keyOfEntry: organizationLine, keyOfRemoval: identity, ordered: false,
};

const TITLE: ListSpec<string, TitleEntry> = {
  field: "titles", prop: "titles", entries: card => card.titles, parse: stringValue("titles"),
  toEntry: name => ({ name }), keyOfEntry: entry => entry.name, keyOfRemoval: identity, ordered: false,
};

const ADDRESS: ListSpec<string, AddressEntry> = {
  field: "addresses", prop: "addresses", entries: card => card.addresses, parse: stringValue("addresses"),
  toEntry: full => ({ full }), keyOfEntry: addressLine, keyOfRemoval: identity, ordered: false,
};

const ONLINE: ListSpec<string, OnlineEntry> = {
  field: "online", prop: "onlineServices", entries: card => card.onlineServices, parse: stringValue("online"),
  toEntry: value => /^[a-z][a-z0-9+.-]*:/i.test(value) ? { uri: value } : { user: value },
  keyOfEntry: onlineValue, keyOfRemoval: identity, ordered: false,
};

// ---------------------------------------------------------------------------
// Birthday

const BIRTHDAY = /^(?:(\d{4})|-)-(\d{2})-(\d{2})$/;

/** The `anniversaries` entry for a `YYYY-MM-DD` or `--MM-DD` birthday. */
function birthdayEntry(raw: string): MapEntry<NonNullable<JmapContactCard["anniversaries"]>> {
  const match = BIRTHDAY.exec(raw);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  if (!match || month < 1 || month > 12 || day < 1 || day > 31) {
    throw invalid('Contact field "birthday" must be YYYY-MM-DD or --MM-DD.');
  }
  return { kind: "birth", date: { "@type": "PartialDate", ...match[1] ? { year: Number(match[1]) } : {}, month, day } };
}

// ---------------------------------------------------------------------------
// Creation

/** The whole card properties for a new contact. It needs something to identify it by. */
export function cardProperties(input: FastmailContactInput): CardProperties {
  if (typeof input !== "object" || input === null) throw invalid("A contact must be an object.");
  const props: CardProperties = {};

  if (input.kind !== undefined) {
    if (input.kind !== "individual" && input.kind !== "org") throw invalid('Contact "kind" must be "individual" or "org".');
    props.kind = input.kind;
  } else {
    props.kind = "individual";
  }

  if (input.name !== undefined || input.givenName !== undefined || input.surname !== undefined) {
    const full = input.name === undefined ? "" : text(input.name, "name");
    const components = [
      ["given", input.givenName === undefined ? "" : text(input.givenName, "givenName")],
      ["surname", input.surname === undefined ? "" : text(input.surname, "surname")],
    ].filter(([, value]) => value).map(([kind, value]) => ({ kind, value }));
    if (full || components.length > 0) {
      props.name = { ...full ? { full } : {}, ...components.length > 0 ? { components } : {} };
    }
  }

  function fill<V, E extends object>(spec: ListSpec<V, E>, values: unknown): void {
    if (values === undefined) return;
    const entries = list(values, spec.field, raw => spec.toEntry(spec.parse(raw)))
      .map((entry, index) => spec.ordered && index < 100 ? { ...entry, pref: index + 1 } : entry);
    const map = idMap(entries);
    if (map) props[spec.prop] = map;
  }
  fill(NICKNAME, input.nicknames);
  fill(EMAIL, input.emails);
  fill(PHONE, input.phones);
  fill(ORGANIZATION, input.organizations);
  fill(TITLE, input.titles);
  fill(ADDRESS, input.addresses);
  fill(ONLINE, input.online);

  if (input.birthday !== undefined && input.birthday !== null) {
    props.anniversaries = { b1: birthdayEntry(text(input.birthday, "birthday")) };
  }
  if (input.notes !== undefined && input.notes !== null) {
    const note = text(input.notes, "notes", MAX_NOTES);
    if (note) props.notes = { n1: { note } };
  }

  if (!props.name && !props.emails && !props.phones && !props.organizations) {
    throw invalid("A new contact needs a name, an email address, a phone number or an organization.");
  }
  return props;
}

// ---------------------------------------------------------------------------
// Changes: validation at staging

function listChange<V, E extends object>(
  raw: unknown, spec: ListSpec<V, E>,
): FastmailContactListChange<V> | undefined {
  if (raw === undefined) return undefined;
  const change = entryObject(raw, spec.field);
  const add = change.add === undefined ? [] : list(change.add, `${spec.field}.add`, spec.parse);
  const remove = change.remove === undefined
    ? []
    : list(change.remove, `${spec.field}.remove`, value => text(value, `${spec.field}.remove`)).filter(Boolean);
  if (add.length === 0 && remove.length === 0) return undefined;
  return { ...add.length > 0 ? { add } : {}, ...remove.length > 0 ? { remove } : {} };
}

/** Checks `input` and returns it normalized (trimmed, empty changes dropped); refuses an empty change. */
export function validateChanges(input: FastmailContactChanges): FastmailContactChanges {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw invalid("The changes must be an object.");
  const changes: FastmailContactChanges = {};

  if (input.kind !== undefined) {
    if (input.kind !== "individual" && input.kind !== "org") throw invalid('Contact "kind" must be "individual" or "org".');
    changes.kind = input.kind;
  }
  for (const field of ["name", "givenName", "surname"] as const) {
    const value = input[field];
    if (value !== undefined) changes[field] = value === null ? null : text(value, field) || null;
  }
  if (input.birthday !== undefined) {
    if (input.birthday === null) {
      changes.birthday = null;
    } else {
      const birthday = text(input.birthday, "birthday");
      birthdayEntry(birthday);
      changes.birthday = birthday;
    }
  }
  if (input.notes !== undefined) {
    changes.notes = input.notes === null ? null : text(input.notes, "notes", MAX_NOTES) || null;
  }

  const emails = listChange(input.emails, EMAIL);
  if (emails) changes.emails = emails;
  const phones = listChange(input.phones, PHONE);
  if (phones) changes.phones = phones;
  const nicknames = listChange(input.nicknames, NICKNAME);
  if (nicknames) changes.nicknames = nicknames;
  const organizations = listChange(input.organizations, ORGANIZATION);
  if (organizations) changes.organizations = organizations;
  const titles = listChange(input.titles, TITLE);
  if (titles) changes.titles = titles;
  const addresses = listChange(input.addresses, ADDRESS);
  if (addresses) changes.addresses = addresses;
  const online = listChange(input.online, ONLINE);
  if (online) changes.online = online;

  if (Object.keys(changes).length === 0) throw invalid("Give at least one contact change.");
  return changes;
}

// ---------------------------------------------------------------------------
// Changes: resolution against the card as it is

/** The PatchObject for `changes` on `card`, and the removal values that match nothing on it. */
export type ContactPatchPlan = { patch: Record<string, unknown>; missing: string[] };

/** A map key not yet used in `taken`, `k1`, `k2`, ... */
function freshKey(taken: Set<string>): string {
  let n = 1;
  while (taken.has(`k${n}`)) n++;
  const key = `k${n}`;
  taken.add(key);
  return key;
}

function planList<V, E extends object>(
  card: JmapContactCard, spec: ListSpec<V, E>, change: FastmailContactListChange<V> | undefined, plan: ContactPatchPlan,
): void {
  if (!change) return;
  const existing = spec.entries(card);
  const taken = new Set(Object.keys(existing ?? {}));
  const keyed = Object.entries(existing ?? {}).map(([id, entry]) => ({ id, entry, key: spec.keyOfEntry(entry) }));

  const removals = (change.remove ?? []).map(value => ({ value, key: spec.keyOfRemoval(value) }));
  for (const { value, key } of removals) {
    if (!keyed.some(candidate => candidate.key === key)) plan.missing.push(`${spec.field}: ${value}`);
  }
  const removeKeys = new Set(removals.map(removal => removal.key));
  const remaining = keyed.filter(candidate => {
    if (candidate.key === undefined || !removeKeys.has(candidate.key)) return true;
    plan.patch[`${spec.prop}/${candidate.id}`] = null;
    return false;
  });

  // A value already on the card (as after a retried apply) is not added a second time.
  const present = new Set(remaining.map(candidate => candidate.key));
  const prefs = remaining.map(candidate => "pref" in candidate.entry && typeof candidate.entry.pref === "number" ? candidate.entry.pref : undefined);
  let nextPref = spec.ordered && prefs.every((pref): pref is number => pref !== undefined)
    ? Math.max(0, ...prefs) + 1
    : undefined;
  const added: Record<string, E> = {};
  for (const value of change.add ?? []) {
    const entry = spec.toEntry(value);
    const key = spec.keyOfEntry(entry);
    if (key !== undefined) {
      if (present.has(key)) continue;
      present.add(key);
    }
    added[freshKey(taken)] = nextPref !== undefined && nextPref <= 100 ? { ...entry, pref: nextPref++ } : entry;
  }
  if (Object.keys(added).length === 0) return;
  if (existing) {
    for (const [id, entry] of Object.entries(added)) plan.patch[`${spec.prop}/${id}`] = entry;
  } else {
    plan.patch[spec.prop] = added;
  }
}

function planName(card: JmapContactCard, changes: FastmailContactChanges, plan: ContactPatchPlan): void {
  const { name, givenName, surname } = changes;
  if (name === undefined && givenName === undefined && surname === undefined) return;
  const current = card.name;
  let components = current?.components;
  let componentsChanged = false;
  for (const [kind, value] of [["given", givenName], ["surname", surname]] as const) {
    if (value === undefined) continue;
    const before = components ?? [];
    const index = before.findIndex(component => component.kind === kind);
    const kept = before.filter(component => component.kind !== kind);
    if (value !== null) {
      // Replace in place (keeping the component's other properties), else join at its natural spot.
      const surnameAt = kept.findIndex(component => component.kind === "surname");
      const at = index >= 0 ? index : kind === "given" && surnameAt >= 0 ? surnameAt : kept.length;
      kept.splice(at, 0, { ...index >= 0 ? before[index] : {}, kind, value });
    }
    components = kept;
    componentsChanged = true;
  }

  if (!current) {
    const full = name ?? undefined;
    if (full || components?.length) {
      plan.patch.name = { ...full ? { full } : {}, ...components?.length ? { components } : {} };
    }
    return;
  }
  if (name !== undefined) {
    if (name === null) {
      if (current.full !== undefined) plan.patch["name/full"] = null;
    } else if (current.full !== name) {
      plan.patch["name/full"] = name;
    }
  }
  if (componentsChanged && (components?.length || current.components)) {
    plan.patch["name/components"] = components?.length ? components : null;
  }
}

function planBirthday(card: JmapContactCard, birthday: string | null, plan: ContactPatchPlan): void {
  const births = Object.entries(card.anniversaries ?? {}).filter(([, anniversary]) => anniversary.kind === "birth");
  if (birthday === null) {
    for (const [id] of births) plan.patch[`anniversaries/${id}`] = null;
    return;
  }
  const entry = birthdayEntry(birthday);
  if (births.length > 0) {
    const [id, current] = births[0];
    plan.patch[`anniversaries/${id}`] = { ...current, date: entry.date };
  } else if (card.anniversaries) {
    plan.patch[`anniversaries/${freshKey(new Set(Object.keys(card.anniversaries)))}`] = entry;
  } else {
    plan.patch.anniversaries = { b1: entry };
  }
}

/**
 * Resolves validated `changes` against `card` as it is now. Only the entries named, and the name
 * components and notes asked for, appear in the patch; everything else on the card is left alone.
 * Adding a value that is already there, or removing one that is not, writes nothing.
 */
export function planContactPatch(card: JmapContactCard, changes: FastmailContactChanges): ContactPatchPlan {
  const plan: ContactPatchPlan = { patch: {}, missing: [] };
  if (changes.kind !== undefined) plan.patch.kind = changes.kind;
  planName(card, changes, plan);
  if (changes.birthday !== undefined) planBirthday(card, changes.birthday, plan);
  if (changes.notes !== undefined) {
    if (changes.notes !== null) plan.patch.notes = { n1: { note: changes.notes } };
    else if (Object.keys(card.notes ?? {}).length > 0) plan.patch.notes = null;
  }
  planList(card, NICKNAME, changes.nicknames, plan);
  planList(card, EMAIL, changes.emails, plan);
  planList(card, PHONE, changes.phones, plan);
  planList(card, ORGANIZATION, changes.organizations, plan);
  planList(card, TITLE, changes.titles, plan);
  planList(card, ADDRESS, changes.addresses, plan);
  planList(card, ONLINE, changes.online, plan);
  return plan;
}
