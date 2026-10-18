/**
 * The contacts resource (see `resource.ts`): one connected account's contact cards over JMAP for
 * Contacts (RFC 9610), either all of them or the members of one contact group.
 *
 * A group is a ContactCard of kind `group` whose `members` set holds the `uid`s of its cards. A group
 * binding re-reads that set on every listing, every `getContact()`, and when staging and applying
 * every change, so membership is live: a contact removed from the group drops out of scope, and one
 * outside it is refused exactly like a missing one.
 *
 * Changes are queued for approval and written by `applyAction()`. Creating, editing and membership
 * changes are auto-approvable; deleting never is.
 */

import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  ActionKind,
  ApprovalQueue,
  Cursor,
  Gatekeeper,
  GatekeeperUserVerifier,
  ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { buildDescription, type RenderedDescription } from "@gadgets/gatekeeper-kit/action-description";
import { OffsetCursor } from "@gadgets/gatekeeper-kit/cursors";
import { cardProperties } from "./contact-input";
import { FastmailError } from "./errors";
import {
  findContactCardByUid,
  getContactCards,
  getContactGroup,
  getDefaultAddressBookId,
  listContactGroups,
  queryContactPage,
  setContactCards,
  type JmapFilter,
} from "./fastmail-api";
import type { JmapContactCard } from "./fastmail-types";
import type { UserAccount } from "./fastmail";
import {
  ALL_CONTACTS_SCOPE,
  parseContactsResourceUrl,
  toContactsResourceUrl,
  type FastmailContactsScope,
} from "./resource";
import { outOfScope } from "./scope";
import type {
  FastmailContact,
  FastmailContactGroup,
  FastmailContactInput,
  FastmailContactsSession,
  FastmailGroupContactsSession,
} from "./types";
import TYPES_CODE from "./types.txt";
import type { ConfiguratorOption } from "./configurator/fastmail-account-configurator-types";
import type {
  FastmailContactsConfiguratorRpc,
  FastmailContactsConfiguratorValues,
} from "./configurator/fastmail-contacts-configurator-types";

type Env = Cloudflare.Env;

export type FastmailContactsGatekeeperImplProps = {
  userObjectId: string;
  scope: FastmailContactsScope;
};

type ContactsGrant = { apiUrl: string; apiToken: string; accountId: string };

/** A JMAP `Id` (RFC 8620 §1.2), as `getContact()` accepts it. */
const JMAP_ID = /^[A-Za-z0-9_-]{1,255}$/;

/** Change kinds a user may opt in to auto-approving. Deleting a contact has none: a person decides. */
const AUTO_APPROVABLE_KINDS = {
  contactCreate: { tag: "contactCreate", label: "Create a contact" },
  contactUpdate: { tag: "contactUpdate", label: "Edit a contact" },
  contactGroup: { tag: "contactGroup", label: "Add or remove a contact from a group" },
} satisfies Record<string, ActionKind>;

/** A queued change, stored under `contactAction:<id>` until it is applied or rejected. */
export type PendingContactAction =
  /** `uid` is minted at staging, so a retried apply finds the card a lost response created. */
  | { kind: "create"; uid: string; card: Record<string, unknown>; groupId?: string }
  | { kind: "update"; id: string; patch: Record<string, unknown> }
  | { kind: "delete"; id: string }
  | { kind: "membership"; id: string; groupId: string; add: boolean };

type Kv = DurableObjectStorage["kv"];

const pendingKey = (actionId: number) => `contactAction:${actionId}`;

async function loadGroup(grant: ContactsGrant, groupId: string): Promise<JmapContactCard> {
  const group = await getContactGroup(grant.apiUrl, grant.apiToken, grant.accountId, groupId);
  if (!group) throw outOfScope("That contact group");
  return group;
}

/** The contact `id`, if the scope admits it now; otherwise not found, like a missing one. */
async function scopedCard(grant: ContactsGrant, scope: FastmailContactsScope, id: string): Promise<JmapContactCard> {
  if (!JMAP_ID.test(id)) throw outOfScope("That contact");
  const [found] = await getContactCards(grant.apiUrl, grant.apiToken, grant.accountId, [id]);
  if (!found || found.kind === "group") throw outOfScope("That contact");
  if (scope.kind === "group" && !(await loadGroup(grant, scope.groupId)).members?.[found.uid]) {
    throw outOfScope("That contact");
  }
  return found;
}

// ---------------------------------------------------------------------------
// JSContact → agent-facing contact

function nameComponent(card: JmapContactCard, kind: string): string | undefined {
  return card.name?.components?.find(component => component.kind === kind)?.value || undefined;
}

/** Map entries of a JSContact property, most-preferred (lowest `pref`) first. */
function byPreference<T extends { pref?: number }>(map: Record<string, T> | undefined): T[] {
  return Object.values(map ?? {}).toSorted((a, b) => (a.pref ?? 101) - (b.pref ?? 101));
}

/** A `label`, else the contexts (and phone features) as a comma list, else nothing. */
function labelOf(entry: { label?: string; contexts?: Record<string, boolean>; features?: Record<string, boolean> }): string | undefined {
  if (entry.label) return entry.label;
  const parts = [...Object.keys(entry.contexts ?? {}), ...Object.keys(entry.features ?? {})];
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function groupName(card: JmapContactCard): string {
  return card.name?.full || card.name?.components?.map(component => component.value).join(" ") || "(unnamed group)";
}

function birthdayOf(card: JmapContactCard): string | undefined {
  const date = Object.values(card.anniversaries ?? {}).find(anniversary => anniversary.kind === "birth")?.date;
  if (!date) return undefined;
  if (date.utc) return date.utc.slice(0, 10);
  if (!date.month || !date.day) return undefined;
  const monthDay = `${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
  return date.year ? `${String(date.year).padStart(4, "0")}-${monthDay}` : `--${monthDay}`;
}

function toAgentContact(card: JmapContactCard): FastmailContact {
  const givenName = nameComponent(card, "given");
  const surname = nameComponent(card, "surname");
  const emails = byPreference(card.emails).map(email => ({ address: email.address, label: labelOf(email) }));
  const organizations = Object.values(card.organizations ?? {}).flatMap(org => {
    const parts = [org.name, ...(org.units ?? []).map(unit => unit.name)].filter((part): part is string => !!part);
    return parts.length > 0 ? [parts.join(" / ")] : [];
  });
  const name = card.name?.full ||
    card.name?.components?.filter(component => component.kind !== "separator").map(component => component.value)
      .join(" ") ||
    organizations[0] || emails[0]?.address || "(no name)";
  const notes = Object.values(card.notes ?? {}).map(note => note.note).filter(Boolean).join("\n\n");
  const birthday = birthdayOf(card);
  return {
    id: card.id,
    kind: card.kind ?? "individual",
    name,
    ...givenName ? { givenName } : {},
    ...surname ? { surname } : {},
    nicknames: Object.values(card.nicknames ?? {}).map(nickname => nickname.name),
    emails: emails.map(email => email.label ? email : { address: email.address }),
    phones: byPreference(card.phones).map(phone => {
      const label = labelOf(phone);
      return label ? { number: phone.number, label } : { number: phone.number };
    }),
    organizations,
    titles: Object.values(card.titles ?? {}).map(title => title.name),
    addresses: Object.values(card.addresses ?? {}).flatMap(address => {
      const line = address.full ||
        (address.components ?? []).filter(component => component.kind !== "separator")
          .map(component => component.value).join(", ");
      return line ? [line] : [];
    }),
    online: Object.values(card.onlineServices ?? {}).flatMap(service => {
      const value = service.uri ?? service.user;
      return value ? [service.service && !service.uri ? `${service.service}: ${value}` : value] : [];
    }),
    ...birthday ? { birthday } : {},
    ...notes ? { notes } : {},
  };
}

function toAgentGroup(card: JmapContactCard): FastmailContactGroup {
  return {
    id: card.id,
    name: groupName(card),
    memberCount: Object.values(card.members ?? {}).filter(Boolean).length,
  };
}

/** The `uid`s a group card lists as members. */
function memberUids(group: JmapContactCard): string[] {
  return Object.keys(group.members ?? {}).filter(uid => group.members![uid]);
}

// ---------------------------------------------------------------------------
// Gatekeeper DO

@validateRpc()
export class FastmailContactsGatekeeperImpl extends DurableObject<Env, FastmailContactsGatekeeperImplProps>
    implements Gatekeeper<FastmailContactsSession | FastmailGroupContactsSession> {
  #userAccount(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  async describe(): Promise<ResourceDescription> {
    const account = this.#userAccount();
    const identity = await account.getIdentity();
    const owner = identity?.email ? `${identity.email} on Fastmail` : "this Fastmail account";
    const scope = this.ctx.props.scope;
    if (scope.kind === "all") {
      return {
        url: toContactsResourceUrl(),
        title: `${identity?.email ?? "Fastmail"}: contacts`,
        snippet: `Read, search and edit the contacts and contact groups of ${owner}. Every change waits for approval.`,
        suggestedBindingName: "FASTMAIL_CONTACTS",
        tsType: "FastmailContactsSession",
      };
    }
    let name = scope.groupId;
    try {
      const grant = await account.getContactsGrant();
      const group = await getContactGroup(grant.apiUrl, grant.apiToken, grant.accountId, scope.groupId);
      if (group) name = groupName(group);
    } catch {
      // The id stands in for the name when the group can't be looked up.
    }
    return {
      url: toContactsResourceUrl(scope),
      title: `${identity?.email ?? "Fastmail"}: contact group "${name}"`,
      snippet: `Read, search and edit the members of the contact group "${name}" in ${owner}. No other ` +
        "contact is visible. Every change waits for approval.",
      suggestedBindingName: "FASTMAIL_CONTACTS",
      tsType: "FastmailGroupContactsSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return Object.values(AUTO_APPROVABLE_KINDS);
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<FastmailContactsSession> {
    return new FastmailContactsSessionImpl(
      approvalQueue.dup(), this.#userAccount(), this.ctx.storage.kv, this.ctx.props.scope);
  }

  /** Action ids being applied in this instance, so a concurrent second approval can't apply twice. */
  #applying = new Set<number>();

  /**
   * Approved: write the change. The scope is checked again, since a contact may have left the group
   * since it was queued. The record is deleted only after Fastmail accepts the change, so a failed
   * apply stays approvable; a retried creation first looks for the card by its minted `uid`.
   */
  async applyAction(actionId: number): Promise<void> {
    const pending = this.ctx.storage.kv.get<PendingContactAction>(pendingKey(actionId));
    if (!pending) throw new Error(`Unknown pending Fastmail contacts action: ${actionId}`);
    if (this.#applying.has(actionId)) throw new Error(`Fastmail contacts action ${actionId} is already being applied.`);
    this.#applying.add(actionId);
    const account = this.#userAccount();
    try {
      const grant = await account.getContactsGrant();
      await applyContactAction(grant, this.ctx.props.scope, pending);
    } catch (error) {
      if (error instanceof FastmailError && error.code === "AUTH_EXPIRED") {
        await account.noteCredentialsExpired();
        throw new Error(
          "Fastmail's API token has expired or been revoked. Please reconnect the account, then " +
          "approve this action again.", { cause: error });
      }
      throw error;
    } finally {
      this.#applying.delete(actionId);
    }
    this.ctx.storage.kv.delete(pendingKey(actionId));
  }

  /** Rejected: nothing was written to Fastmail; drop the queued change. */
  async rejectAction(actionId: number): Promise<void> {
    this.ctx.storage.kv.delete(pendingKey(actionId));
  }

  async revertAction(_actionId: number): Promise<{ message: string; canRetry: boolean }> {
    return {
      message: "Contact changes can't be reverted automatically. Edit the contact yourself in Fastmail.",
      canRetry: false,
    };
  }

  /** Private-only, as the mailbox (see FastmailGatekeeperImpl.addObserver). */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    throw new Error(
      "These Fastmail contacts cannot be shared with other users: they may only be observed by the " +
      "person who connected them.");
  }

  async removeObserver(_id: string): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Session

/**
 * Serves both session types: for a group binding, `listGroups()` shows only the bound group and a
 * `groupId` other than it is refused as not found.
 */
@validateRpc()
export class FastmailContactsSessionImpl extends RpcTarget implements FastmailContactsSession, FastmailGroupContactsSession {
  #approvalQueue: RpcStub<ApprovalQueue>;
  #account: DurableObjectStub<UserAccount>;
  #kv: Kv;
  #scope: FastmailContactsScope;

  constructor(
      approvalQueue: RpcStub<ApprovalQueue>, account: DurableObjectStub<UserAccount>, kv: Kv,
      scope: FastmailContactsScope = ALL_CONTACTS_SCOPE) {
    super();
    this.#approvalQueue = approvalQueue;
    this.#account = account;
    this.#kv = kv;
    this.#scope = scope;
  }

  [Symbol.dispose]() {
    this.#approvalQueue[Symbol.dispose]();
  }

  async #call<T>(fn: (grant: ContactsGrant) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.#account.getContactsGrant());
    } catch (error) {
      if (error instanceof FastmailError && error.code === "AUTH_EXPIRED") {
        await this.#account.noteCredentialsExpired();
        throw new Error(
          "Fastmail's API token has expired or been revoked. Please reconnect the account.", { cause: error });
      }
      throw error;
    }
  }

  /** The group a call is confined to: the binding's own, or the caller's within a whole-book binding. */
  #groupFor(groupId: string | undefined): string | undefined {
    if (this.#scope.kind === "all") {
      if (groupId !== undefined && !JMAP_ID.test(groupId)) throw outOfScope("That contact group");
      return groupId;
    }
    if (groupId !== undefined && groupId !== this.#scope.groupId) throw outOfScope("That contact group");
    return this.#scope.groupId;
  }

  async listGroups(): Promise<FastmailContactGroup[]> {
    const groups = await this.#call(async grant => this.#scope.kind === "all"
      ? await listContactGroups(grant.apiUrl, grant.apiToken, grant.accountId)
      : [await loadGroup(grant, this.#scope.groupId)]);
    await this.#approvalQueue.authorizeObservation({
      title: "List Fastmail contact groups",
      description: `Read ${groups.length} Fastmail contact group(s).`,
    });
    return groups.map(toAgentGroup).toSorted((a, b) => a.name.localeCompare(b.name));
  }

  async getGroup(): Promise<FastmailContactGroup> {
    const scope = this.#scope;
    if (scope.kind !== "group") {
      throw new FastmailError("INVALID_RESOURCE", "This binding covers every contact; use listGroups().");
    }
    const group = await this.#call(grant => loadGroup(grant, scope.groupId));
    await this.#approvalQueue.authorizeObservation({
      title: "Read Fastmail contact group",
      description: `Read the Fastmail contact group "${groupName(group)}".`,
    });
    return toAgentGroup(group);
  }

  #contactCursor(groupId: string | undefined, text: string | undefined): Cursor<FastmailContact> {
    // Before dup(): a group outside the binding throws without leaking a stub.
    const group = this.#groupFor(groupId);
    const approvalQueue = this.#approvalQueue.dup();
    const call = this.#call.bind(this);
    return new OffsetCursor<FastmailContact>({
      pageSize: 50,
      dispose: () => approvalQueue[Symbol.dispose](),
      fetchPage: (offset, limit) => call(async grant => {
        // Groups are dropped by `retain`, not by the query: Fastmail mis-parses a `kind` condition
        // nested in a FilterOperator (it hoists `kind` to the operator itself, so
        // NOT{kind: group} matches nothing), while `uid` and `text` conditions nest correctly.
        const conditions: JmapFilter[] = [];
        if (group !== undefined) {
          // Membership is re-read for every page, so it is never older than the page it filters.
          const uids = memberUids(await loadGroup(grant, group));
          if (uids.length === 0) return [];
          conditions.push({ operator: "OR", conditions: uids.map(uid => ({ uid })) });
        }
        if (text) conditions.push({ text });
        const filter = conditions.length > 1 ? { operator: "AND", conditions } : conditions[0];
        const cards = await queryContactPage(grant.apiUrl, grant.apiToken, grant.accountId, filter, offset, limit);
        // Group cards keep `kind: "group"` here, for `retain` to drop.
        return cards.map(toAgentContact);
      }),
      // The walk advances by the raw page, so a page of only groups doesn't end it early.
      retain: page => page.filter(contact => contact.kind !== "group"),
      authorizePage: (items, { terminal }) => approvalQueue.authorizeObservation({
        title: "List Fastmail contacts",
        description: terminal && items.length === 0
          ? "Listed Fastmail contacts; there were none matching."
          : `Read ${items.length} Fastmail contact(s).`,
      }),
    });
  }

  async listContacts(groupId?: string): Promise<Cursor<FastmailContact>> {
    return this.#contactCursor(groupId, undefined);
  }

  async searchContacts(query: string, groupId?: string): Promise<Cursor<FastmailContact>> {
    const text = query.trim();
    if (!text) throw new FastmailError("INVALID_RESOURCE", "A contact search needs some text to search for.");
    return this.#contactCursor(groupId, text);
  }

  async getContact(id: string): Promise<FastmailContact> {
    const contact = toAgentContact(await this.#call(grant => scopedCard(grant, this.#scope, id)));
    await this.#approvalQueue.authorizeObservation({
      title: "Read Fastmail contact",
      description: `Read the Fastmail contact "${contact.name}".`,
    });
    return contact;
  }

  /**
   * Stores `action` and queues it for approval. Like the mailbox's sends, the record is not removed
   * if `submitAction()` throws: the overseer may have committed the action anyway.
   */
  async #stage(
    action: PendingContactAction, title: string, description: RenderedDescription, kind?: ActionKind,
  ): Promise<void> {
    const actionId = this.#kv.get<number>("contactAction:nextId") ?? 1;
    this.#kv.put("contactAction:nextId", actionId + 1);
    this.#kv.put(pendingKey(actionId), action);
    await this.#approvalQueue.submitAction(actionId, {
      title,
      ...description,
      implementsRevert: false,
      ...kind ? { actionKind: kind, autoApprovable: true } : {},
    });
  }

  async createContact(contact: FastmailContactInput, groupId?: string): Promise<void> {
    const card = cardProperties(contact, { create: true });
    const target = this.#groupFor(groupId);
    const group = target === undefined ? undefined : await this.#call(grant => loadGroup(grant, target));
    const uid = `urn:uuid:${crypto.randomUUID()}`;
    const builder = buildDescription(
      `Create a new contact in this Fastmail account's default address book` +
      `${group ? `, as a member of the group "${plainInline(groupName(group))}"` : ""}.`);
    builder.json("Contact card", card);
    await this.#stage(
      { kind: "create", uid, card, ...target === undefined ? {} : { groupId: target } },
      `Create Fastmail contact ${describeCard(card)}`, builder.finish(), AUTO_APPROVABLE_KINDS.contactCreate);
  }

  async updateContact(id: string, changes: FastmailContactInput): Promise<void> {
    const patch = cardProperties(changes, { create: false });
    const current = toAgentContact(await this.#call(grant => scopedCard(grant, this.#scope, id)));
    const builder = buildDescription(
      `Change the Fastmail contact "${plainInline(current.name)}". Each property shown replaces the ` +
      "contact's current one; null removes it.");
    builder.json("Changes", patch);
    await this.#stage(
      { kind: "update", id, patch }, `Edit Fastmail contact ${current.name}`, builder.finish(),
      AUTO_APPROVABLE_KINDS.contactUpdate);
  }

  async deleteContact(id: string): Promise<void> {
    const current = toAgentContact(await this.#call(grant => scopedCard(grant, this.#scope, id)));
    const builder = buildDescription(
      `Delete the Fastmail contact "${plainInline(current.name)}" from this account, and with it from ` +
      "every group. This can't be undone.");
    builder.json("Contact", current);
    await this.#stage({ kind: "delete", id }, `Delete Fastmail contact ${current.name}`, builder.finish());
  }

  async addToGroup(contactId: string, groupId: string): Promise<void> {
    // A group binding can't pull other contacts into its scope.
    if (this.#scope.kind === "group") {
      throw new FastmailError("INVALID_RESOURCE", "This binding can't add existing contacts to its group.");
    }
    await this.#stageMembership(contactId, this.#groupFor(groupId) ?? groupId, true);
  }

  async removeFromGroup(contactId: string, groupId?: string): Promise<void> {
    const target = this.#groupFor(groupId);
    if (target === undefined) throw new FastmailError("INVALID_RESOURCE", "Say which group to remove the contact from.");
    await this.#stageMembership(contactId, target, false);
  }

  /** `target` is a group id already checked against the scope by `#groupFor()`. */
  async #stageMembership(contactId: string, target: string, add: boolean): Promise<void> {
    const { card, group } = await this.#call(async grant => ({
      card: await scopedCard(grant, this.#scope, contactId),
      group: await loadGroup(grant, target),
    }));
    const name = toAgentContact(card).name;
    const groupLabel = groupName(group);
    const builder = buildDescription(add
      ? `Add the Fastmail contact "${plainInline(name)}" to the group "${plainInline(groupLabel)}".`
      : `Remove the Fastmail contact "${plainInline(name)}" from the group "${plainInline(groupLabel)}". ` +
        "The contact itself stays.");
    builder.inline("Contact", name).inline("Group", groupLabel);
    await this.#stage(
      { kind: "membership", id: contactId, groupId: target, add },
      `${add ? "Add" : "Remove"} ${name} ${add ? "to" : "from"} ${groupLabel}`, builder.finish(),
      AUTO_APPROVABLE_KINDS.contactGroup);
  }
}

/** User-controlled text kept to one line and out of the Markdown. */
function plainInline(text: string): string {
  return text.replace(/[\r\n"`*_[\]<>]/g, " ").trim();
}

/** A short name for a card about to be created, for the approval title. */
function describeCard(card: Record<string, unknown>): string {
  return toAgentContact({ id: "", uid: "", ...card } as JmapContactCard).name;
}

/** Writes one approved change to Fastmail, re-checking the binding's scope first. */
export async function applyContactAction(
  grant: ContactsGrant, scope: FastmailContactsScope, action: PendingContactAction,
): Promise<void> {
  const { apiUrl, apiToken, accountId } = grant;
  switch (action.kind) {
    case "create": {
      const group = action.groupId === undefined ? undefined : await loadGroup(grant, action.groupId);
      const existing = await findContactCardByUid(apiUrl, apiToken, accountId, action.uid);
      const addressBookId = existing ? undefined : await getDefaultAddressBookId(apiUrl, apiToken, accountId);
      await setContactCards(apiUrl, apiToken, accountId, {
        ...addressBookId ? {
          create: {
            c: { "@type": "Card", version: "1.0", ...action.card, uid: action.uid, addressBookIds: { [addressBookId]: true } },
          },
        } : {},
        ...group ? { update: { [group.id]: { [`members/${action.uid}`]: true } } } : {},
      });
      return;
    }
    case "update":
      await scopedCard(grant, scope, action.id);
      await setContactCards(apiUrl, apiToken, accountId, { update: { [action.id]: action.patch } });
      return;
    case "delete":
      await scopedCard(grant, scope, action.id);
      await setContactCards(apiUrl, apiToken, accountId, { destroy: [action.id] });
      return;
    case "membership": {
      const card = await scopedCard(grant, scope, action.id);
      const group = await loadGroup(grant, action.groupId);
      await setContactCards(apiUrl, apiToken, accountId, {
        update: { [group.id]: { [`members/${card.uid}`]: action.add ? true : null } },
      });
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Resource configurator

@validateRpc()
export class FastmailContactsConfiguratorUI extends RpcTarget implements FastmailContactsConfiguratorRpc {
  constructor(private readonly account?: DurableObjectStub<UserAccount>) {
    super();
  }

  async resourceUrl(values?: FastmailContactsConfiguratorValues): Promise<string> {
    if ((values?.mode ?? "all") === "all") return toContactsResourceUrl();
    if (!values?.groupId) throw new FastmailError("INVALID_RESOURCE", "Choose a contact group.");
    return toContactsResourceUrl({ kind: "group", groupId: values.groupId });
  }

  async listGroups(query: string): Promise<ConfiguratorOption[]> {
    if (!this.account) return [];
    const grant = await this.account.getContactsGrant();
    const needle = query.trim().toLowerCase();
    return (await listContactGroups(grant.apiUrl, grant.apiToken, grant.accountId))
      .map(toAgentGroup)
      .filter(group => !needle || group.name.toLowerCase().includes(needle))
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .slice(0, 50)
      .map(group => ({ value: group.id, title: group.name, meta: `${group.memberCount} contact(s)` }));
  }

  async valuesFromResourceUrl(resourceUrl: string): Promise<FastmailContactsConfiguratorValues> {
    const scope = parseContactsResourceUrl(resourceUrl);
    return scope.kind === "group" ? { mode: "group", groupId: scope.groupId } : { mode: "all" };
  }
}
