import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcStub } from "cloudflare:workers";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import {
  applyContactAction,
  FastmailContactsConfiguratorUI,
  FastmailContactsSessionImpl,
  type PendingContactAction,
} from "../src/contacts";
import type { UserAccount } from "../src/fastmail";
import type { JmapContactCard } from "../src/fastmail-types";
import { FastmailError } from "../src/errors";
import {
  FASTMAIL_CONTACTS_RESOURCE,
  FASTMAIL_RESOURCE,
  isContactsResourceUrl,
  parseContactsResourceUrl,
  toContactsResourceUrl,
  type FastmailContactsScope,
} from "../src/resource";

const CARDS: JmapContactCard[] = [
  {
    id: "c1", uid: "u1", kind: "individual",
    name: { components: [{ kind: "given", value: "Ada" }, { kind: "surname", value: "Lovelace" }] },
    emails: {
      e2: { address: "ada@home.example", contexts: { private: true }, pref: 2 },
      e1: { address: "ada@work.example", label: "Engine", pref: 1 },
    },
    phones: { p1: { number: "+44 1", features: { mobile: true } } },
    organizations: { o1: { name: "Analytical", units: [{ name: "Research" }] } },
    anniversaries: { a1: { kind: "birth", date: { "@type": "PartialDate", month: 12, day: 10 } } },
    notes: { n1: { note: "Met at the salon" } },
  },
  { id: "c2", uid: "u2", kind: "individual", name: { full: "Charles Babbage" }, emails: { e: { address: "cb@example" } } },
  { id: "c3", uid: "u3", kind: "org", organizations: { o: { name: "Royal Society" } } },
  { id: "g1", uid: "ug1", kind: "group", name: { full: "Friends" }, members: { u1: true, u3: true } },
  { id: "g2", uid: "ug2", kind: "group", name: { full: "Empty" }, members: {} },
];

type Filter = { operator?: "AND" | "OR" | "NOT"; conditions?: Filter[]; kind?: string; uid?: string; text?: string };
type MethodArgs = { filter?: Filter; position?: number; limit?: number; ids?: string[]; "#ids"?: { resultOf: string } };

/**
 * Evaluates the subset of RFC 9610 filters the gatekeeper sends. Like Fastmail (seen live), it
 * hoists a `kind` condition nested in an operator onto the operator itself, leaving `{}` behind,
 * so `NOT {kind: "group"}` matches nothing.
 */
function matches(card: JmapContactCard, filter: Filter | undefined): boolean {
  if (!filter) return true;
  if (filter.operator) {
    const hoisted = filter.conditions?.find(c => !c.operator && c.kind !== undefined)?.kind;
    if (hoisted !== undefined && card.kind !== hoisted) return false;
    const conditions = (filter.conditions ?? []).map(c => c.operator ? c : { ...c, kind: undefined });
    if (filter.operator === "AND") return conditions.every(c => matches(card, c));
    if (filter.operator === "OR") return conditions.some(c => matches(card, c));
    return !conditions.some(c => matches(card, c));
  }
  if (filter.kind !== undefined && card.kind !== filter.kind) return false;
  if (filter.uid !== undefined && card.uid !== filter.uid) return false;
  if (filter.text !== undefined && !JSON.stringify(card).toLowerCase().includes(filter.text.toLowerCase())) return false;
  return true;
}

type SetArgs = {
  create?: Record<string, Record<string, unknown>>;
  update?: Record<string, Record<string, unknown>>;
  destroy?: string[];
};

/**
 * A fake JMAP Contacts API over a copy of CARDS that returns ContactCard/get lists out of request
 * order and applies ContactCard/set to its copy, which it returns.
 */
function fakeContacts(): { cards: JmapContactCard[]; sets: SetArgs[] } {
  const cards = structuredClone(CARDS);
  const sets: SetArgs[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const { using, methodCalls } = JSON.parse(init.body as string) as {
      using: string[]; methodCalls: [string, MethodArgs & SetArgs, string][];
    };
    expect(using).toContain("urn:ietf:params:jmap:contacts");
    const queried: Record<string, string[]> = {};
    const methodResponses = methodCalls.map(([name, args, callId]) => {
      if (name === "ContactCard/query") {
        const ids = cards.filter(card => matches(card, args.filter)).map(card => card.id);
        const start = args.position ?? 0;
        queried[callId] = ids.slice(start, start + (args.limit ?? ids.length));
        return [name, { ids: queried[callId] }, callId];
      }
      if (name === "ContactCard/get") {
        const ids = args["#ids"] ? queried[args["#ids"].resultOf] : args.ids ?? [];
        return [name, { list: cards.filter(card => ids.includes(card.id)).toReversed() }, callId];
      }
      if (name === "AddressBook/get") {
        return [name, { list: [{ id: "other" }, { id: "default", isDefault: true }] }, callId];
      }
      if (name === "ContactCard/set") {
        sets.push(args);
        const notUpdated: Record<string, { type: string }> = {};
        for (const [key, card] of Object.entries(args.create ?? {})) {
          cards.push({ ...card, id: `new-${key}` } as JmapContactCard);
        }
        for (const [id, patch] of Object.entries(args.update ?? {})) {
          const card = cards.find(candidate => candidate.id === id) as Record<string, unknown> | undefined;
          if (!card) {
            notUpdated[id] = { type: "notFound" };
            continue;
          }
          for (const [path, value] of Object.entries(patch)) {
            const [top, inner] = path.split("/");
            const target = inner === undefined ? card : (card[top] ??= {}) as Record<string, unknown>;
            const key = inner ?? top;
            if (value === null) delete target[key];
            else target[key] = value;
          }
        }
        for (const id of args.destroy ?? []) cards.splice(cards.findIndex(card => card.id === id), 1);
        return [name, { notUpdated }, callId];
      }
      throw new Error(`Unexpected JMAP call ${name}`);
    });
    return new Response(JSON.stringify({ methodResponses }));
  }));
  return { cards, sets };
}

const GRANT = { apiUrl: "https://api/", apiToken: "token", accountId: "c-acct" };

function setup(scope: FastmailContactsScope) {
  const queue = {
    authorizeObservation: vi.fn(async (_description: unknown) => {}),
    submitAction: vi.fn(async (_id: number, _description: Record<string, unknown>) => {}),
    dup: () => queue,
    [Symbol.dispose]: () => {},
  };
  const account = {
    getContactsGrant: vi.fn(async () => GRANT),
    noteCredentialsExpired: vi.fn(async () => {}),
  };
  const store = new Map<string, unknown>();
  const kv = {
    get: (key: string) => structuredClone(store.get(key)),
    put: (key: string, value: unknown) => void store.set(key, structuredClone(value)),
    delete: (key: string) => store.delete(key),
  };
  const session = new FastmailContactsSessionImpl(
    queue as unknown as RpcStub<ApprovalQueue>, account as unknown as DurableObjectStub<UserAccount>,
    kv as unknown as DurableObjectStorage["kv"], scope);
  /** Applies the queued action `actionId` as an approval would. */
  const approve = (actionId: number) =>
    applyContactAction(GRANT, scope, store.get(`contactAction:${actionId}`) as PendingContactAction);
  return { session, queue, account, approve };
}

async function drain<T>(cursor: { next(): Promise<T[] | null> }): Promise<T[]> {
  const all: T[] = [];
  for (let page = await cursor.next(); page !== null; page = await cursor.next()) all.push(...page);
  return all;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("contacts resource URL", () => {
  it("round-trips all contacts and a group, under its own urlPattern", () => {
    expect(toContactsResourceUrl()).toBe("https://api.fastmail.com/jmap/contacts/account");
    const group = toContactsResourceUrl({ kind: "group", groupId: "g1" });
    expect(group).toBe("https://api.fastmail.com/jmap/contacts/account#group/g1");
    expect(parseContactsResourceUrl(group)).toEqual({ kind: "group", groupId: "g1" });
    expect(parseContactsResourceUrl(toContactsResourceUrl())).toEqual({ kind: "all" });
    for (const url of [toContactsResourceUrl(), group]) {
      expect(new URLPattern(FASTMAIL_CONTACTS_RESOURCE.urlPattern).test(url)).toBe(true);
      expect(new URLPattern(FASTMAIL_RESOURCE.urlPattern).test(url)).toBe(false);
      expect(isContactsResourceUrl(url)).toBe(true);
    }
    expect(isContactsResourceUrl("https://api.fastmail.com/jmap/mail/account")).toBe(false);
  });

  it("rejects foreign URLs and malformed scopes", () => {
    for (const url of [
      "https://evil.example/jmap/contacts/account", "https://api.fastmail.com/jmap/contacts/other",
      "https://api.fastmail.com/jmap/contacts/account?x=1", "https://api.fastmail.com/jmap/contacts/account#group/",
      "https://api.fastmail.com/jmap/contacts/account#group/a b", "https://api.fastmail.com/jmap/contacts/account#mailbox/x",
    ]) {
      expect(() => parseContactsResourceUrl(url), url).toThrow(FastmailError);
    }
  });
});

describe("whole contacts binding", () => {
  it("lists contacts but not groups, mapping JSContact cards", async () => {
    fakeContacts();
    const { session, queue } = setup({ kind: "all" });
    const contacts = await drain(await session.listContacts());
    expect(contacts.map(contact => contact.id)).toEqual(["c1", "c2", "c3"]);
    expect(contacts[0]).toEqual({
      id: "c1", kind: "individual", name: "Ada Lovelace", givenName: "Ada", surname: "Lovelace", nicknames: [],
      emails: [{ address: "ada@work.example", label: "Engine" }, { address: "ada@home.example", label: "private" }],
      phones: [{ number: "+44 1", label: "mobile" }],
      organizations: ["Analytical / Research"], titles: [], addresses: [], online: [],
      birthday: "--12-10", notes: "Met at the salon",
    });
    expect(contacts[2].name).toBe("Royal Society");
    expect(queue.authorizeObservation).toHaveBeenCalled();
  });

  it("lists groups and narrows listings and searches to one", async () => {
    fakeContacts();
    const { session } = setup({ kind: "all" });
    expect(await session.listGroups()).toEqual([
      { id: "g2", name: "Empty", memberCount: 0 }, { id: "g1", name: "Friends", memberCount: 2 },
    ]);
    expect((await drain(await session.listContacts("g1"))).map(c => c.id)).toEqual(["c1", "c3"]);
    expect(await drain(await session.listContacts("g2"))).toEqual([]);
    expect((await drain(await session.searchContacts("babbage"))).map(c => c.id)).toEqual(["c2"]);
    expect(await drain(await session.searchContacts("babbage", "g1"))).toEqual([]);
    await expect(session.getContact("g1")).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(drain(await session.listContacts("c1"))).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });
});

describe("group contacts binding", () => {
  it("sees only the group's current members", async () => {
    fakeContacts();
    const { session } = setup({ kind: "group", groupId: "g1" });
    expect(await session.getGroup()).toEqual({ id: "g1", name: "Friends", memberCount: 2 });
    expect((await drain(await session.listContacts())).map(c => c.id)).toEqual(["c1", "c3"]);
    expect((await drain(await session.searchContacts("royal"))).map(c => c.id)).toEqual(["c3"]);
    expect(await drain(await session.searchContacts("babbage"))).toEqual([]);
    expect((await session.getContact("c1")).name).toBe("Ada Lovelace");
  });

  it("refuses contacts and groups outside it exactly like missing ones", async () => {
    fakeContacts();
    const { session, queue } = setup({ kind: "group", groupId: "g1" });
    for (const id of ["c2", "g1", "missing", "bad id"]) {
      await expect(session.getContact(id), id).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    }
    await expect(session.listContacts("g2")).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    expect((await session.listGroups()).map(group => group.id)).toEqual(["g1"]);
    expect(queue.authorizeObservation).toHaveBeenCalledTimes(1);
  });

  it("fails as not found once the group is gone", async () => {
    fakeContacts();
    const { session } = setup({ kind: "group", groupId: "c1" });
    await expect(session.getGroup()).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(drain(await session.listContacts())).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });
});

describe("contact changes", () => {
  it("queues a creation as JSContact and writes it on approval, into the default book and group", async () => {
    const jmap = fakeContacts();
    const { session, queue, approve } = setup({ kind: "all" });
    await session.createContact({
      givenName: "Grace", surname: "Hopper", emails: [{ address: "grace@navy.example", label: "work" }],
      phones: [{ number: "+1 2", label: "work, mobile" }, { number: "+1 3", label: "Lab" }],
      organizations: ["Navy / Computing"], birthday: "1906-12-09",
    }, "g1");
    const [[actionId, description]] = queue.submitAction.mock.calls;
    expect(description).toMatchObject({
      title: "Create Fastmail contact Grace Hopper", actionKind: { tag: "contactCreate" }, autoApprovable: true,
    });
    expect(jmap.sets).toHaveLength(0);

    await approve(actionId);
    const created = jmap.cards.find(card => card.id === "new-c")!;
    expect(created).toMatchObject({
      "@type": "Card", kind: "individual", addressBookIds: { default: true },
      name: { components: [{ kind: "given", value: "Grace" }, { kind: "surname", value: "Hopper" }] },
      emails: { k1: { address: "grace@navy.example", contexts: { work: true }, pref: 1 } },
      phones: {
        k1: { number: "+1 2", contexts: { work: true }, features: { mobile: true }, pref: 1 },
        k2: { number: "+1 3", label: "Lab", pref: 2 },
      },
      organizations: { k1: { name: "Navy", units: [{ name: "Computing" }] } },
      anniversaries: { b1: { kind: "birth", date: { "@type": "PartialDate", year: 1906, month: 12, day: 9 } } },
    });
    expect(jmap.cards.find(card => card.id === "g1")!.members).toHaveProperty([created.uid], true);

    // A retry after a lost response finds the card by its uid instead of creating a second one.
    await approve(actionId);
    expect(jmap.cards.filter(card => card.uid === created.uid)).toHaveLength(1);
  });

  it("adds a contact created through a group binding to that group", async () => {
    const jmap = fakeContacts();
    const { session, queue, approve } = setup({ kind: "group", groupId: "g2" });
    await session.createContact({ name: "New Friend" });
    await approve(queue.submitAction.mock.calls[0][0]);
    const created = jmap.cards.find(card => card.id === "new-c")!;
    expect(jmap.cards.find(card => card.id === "g2")!.members).toEqual({ [created.uid]: true });
  });

  it("patches only the fields given, and null clears one", async () => {
    const jmap = fakeContacts();
    const { session, queue, approve } = setup({ kind: "all" });
    await session.updateContact("c1", { emails: [], notes: null, titles: ["Countess"] });
    expect(queue.submitAction.mock.calls[0][1]).toMatchObject({ title: "Edit Fastmail contact Ada Lovelace" });
    await approve(queue.submitAction.mock.calls[0][0]);
    const card = jmap.cards.find(candidate => candidate.id === "c1")!;
    expect(card.emails).toBeUndefined();
    expect(card.notes).toBeUndefined();
    expect(card.titles).toEqual({ k1: { name: "Countess" } });
    expect(card.name?.components).toHaveLength(2);
  });

  it("never offers deletes for auto-approval", async () => {
    const jmap = fakeContacts();
    const { session, queue, approve } = setup({ kind: "all" });
    await session.deleteContact("c2");
    const [[actionId, description]] = queue.submitAction.mock.calls;
    expect(description).not.toHaveProperty("actionKind");
    expect(description).not.toHaveProperty("autoApprovable");
    await approve(actionId);
    expect(jmap.cards.map(card => card.id)).not.toContain("c2");
  });

  it("adds to and removes from groups by uid", async () => {
    const jmap = fakeContacts();
    const { session, queue, approve } = setup({ kind: "all" });
    await session.addToGroup("c2", "g1");
    await session.removeFromGroup("c1", "g1");
    for (const [actionId] of queue.submitAction.mock.calls) await approve(actionId);
    expect(jmap.cards.find(card => card.id === "g1")!.members).toEqual({ u2: true, u3: true });
  });

  it("keeps a group binding's changes inside its group, at staging and at approval", async () => {
    const jmap = fakeContacts();
    const { session, queue, approve } = setup({ kind: "group", groupId: "g1" });
    await expect(session.updateContact("c2", { name: "X" })).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(session.deleteContact("c2")).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(session.removeFromGroup("c1", "g2")).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(session.addToGroup("c2", "g1")).rejects.toThrow(FastmailError);
    expect(queue.submitAction).not.toHaveBeenCalled();

    await session.deleteContact("c1");
    await session.removeFromGroup("c1");
    // c1 leaves the group before either is approved: neither may touch it any more.
    delete jmap.cards.find(card => card.id === "g1")!.members!.u1;
    for (const [actionId] of queue.submitAction.mock.calls) {
      await expect(approve(actionId)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    }
    expect(jmap.cards.map(card => card.id)).toContain("c1");
  });

  it("rejects invalid input before queueing", async () => {
    fakeContacts();
    const { session, queue } = setup({ kind: "all" });
    await expect(session.createContact({ notes: "only a note" })).rejects.toThrow(FastmailError);
    await expect(session.createContact({ emails: [{ address: "not an address" }] })).rejects.toThrow(FastmailError);
    await expect(session.updateContact("c1", { birthday: "12/10" })).rejects.toThrow(FastmailError);
    await expect(session.updateContact("c1", {})).rejects.toThrow(FastmailError);
    expect(queue.submitAction).not.toHaveBeenCalled();
  });
});

describe("contacts configurator", () => {
  it("mints validated URLs and lists groups", async () => {
    fakeContacts();
    const account = { getContactsGrant: async () => GRANT };
    const ui = new FastmailContactsConfiguratorUI(account as unknown as DurableObjectStub<UserAccount>);
    expect(await ui.resourceUrl()).toBe("https://api.fastmail.com/jmap/contacts/account");
    expect(await ui.resourceUrl({ mode: "group", groupId: "g1" }))
      .toBe("https://api.fastmail.com/jmap/contacts/account#group/g1");
    await expect(ui.resourceUrl({ mode: "group" })).rejects.toThrow(FastmailError);
    expect(await ui.listGroups("fri")).toEqual([{ value: "g1", title: "Friends", meta: "2 contact(s)" }]);
    expect(await ui.valuesFromResourceUrl("https://api.fastmail.com/jmap/contacts/account#group/g1"))
      .toEqual({ mode: "group", groupId: "g1" });
  });
});
