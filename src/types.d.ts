import type { RpcStub } from "cloudflare:workers";
import type { Cursor } from "@gadgets/workshop-shared/gatekeeper";

/** Forward-only paginated results. Call `next()` repeatedly on the same cursor to fetch successive
 * batches, until it returns `null` — an empty array is not exhaustion, only `null` is. Dispose the
 * cursor when finished, including when stopping early. */
export type { Cursor };

/** One of Fastmail's standard system folder roles (JMAP Mailbox `role`), when set. */
export type FastmailFolderRole =
  | "inbox" | "sent" | "drafts" | "trash" | "junk" | "archive"
  // Fastmail's other special folders: mail it will send later, and mail snoozed until a set time.
  | "scheduled" | "snoozed"
  // Other roles a JMAP server may assign (RFC 8457).
  | "all" | "flagged" | "important" | "subscribed";

/** One Fastmail folder (a JMAP Mailbox — closer to an IMAP folder than a Gmail label: an email can
 * still live in more than one Mailbox at once). */
export type FastmailFolder = {
  /** Pass this to `listThreads()`/`searchThreads()`'s `folderId`, or `moveToFolder()`. */
  id: string;
  name: string;
  /** Set for Fastmail's built-in system folders (Inbox, Sent, Drafts, Trash, Junk, Archive, ...); null
   * for a folder you created yourself. Use this to find "the archive folder" or "the trash folder"
   * rather than matching on `name`, which is user-renamable. */
  role: FastmailFolderRole | null;
  /** Parent folder's id, or null for a top-level folder. */
  parentId: string | null;
  totalEmails: number;
  unreadEmails: number;
};

/** One thread in a folder listing or search result, without its message bodies. */
export type FastmailThreadEntry = {
  /** Pass this to `getThread()`. */
  threadId: string;
  subject: string;
  /** Display-formatted sender of the thread's most recent message. */
  from: string;
  lastMessageAt: Date;
  unread: boolean;
  /** Short plain-text preview of the most recent message. */
  snippet: string;
};

/**
 * Structured conditions for `searchThreads()` and `searchMessages()`: every condition given must
 * match, and at least one is required. Text conditions match as Fastmail's own search does,
 * case-insensitively, and are at most 256 characters.
 *
 * @example
 * ```ts
 * // Unread, flagged mail from a sender received in October 2026.
 * const search: FastmailSearch = {
 *   from: "shop@example.com", unread: true, flagged: true, after: "2026-10-01", before: "2026-11-01",
 * };
 * ```
 */
export type FastmailSearch = {
  /** Full-text search over headers and body. */
  text?: string;
  /** Matches the sender's name or address. */
  from?: string;
  /** Matches a To recipient's name or address. */
  to?: string;
  subject?: string;
  /** `true`: messages not yet read (no `"$seen"` keyword); `false`: messages already read. */
  unread?: boolean;
  /** `true`: messages with the `"$flagged"` keyword; `false`: messages without it. */
  flagged?: boolean;
  /** The message must carry this JMAP keyword, e.g. `"$answered"` or a custom label. */
  hasKeyword?: string;
  /** The message must not carry this JMAP keyword. */
  notKeyword?: string;
  /** `true`: messages with an attachment; `false`: messages without. */
  hasAttachment?: boolean;
  /** Received at or after this time: a date `YYYY-MM-DD` (UTC midnight) or a UTCDate such as `2026-10-01T08:00:00Z`. Must be before `before`, if both are given. */
  after?: string;
  /** Received before this time: a date `YYYY-MM-DD` (UTC midnight) or a UTCDate. */
  before?: string;
};

/** What `updateThreads()` does to every message of the threads it is given. Exactly one change. */
export type FastmailThreadChange =
  /** Moves them into this folder (`FastmailFolder.id`), as `FastmailThread.moveToFolder()` does. */
  | { moveToFolder: string }
  /** Adds this JMAP keyword (e.g. `"$flagged"`, or a custom label). */
  | { addKeyword: string }
  /** Removes this JMAP keyword. */
  | { removeKeyword: string }
  /** Marks them read (adds `"$seen"`). */
  | { markRead: true }
  /** Marks them unread (removes `"$seen"`). */
  | { markUnread: true };

export type FastmailAddress = { email: string; name?: string };

/** One attachment on a message. Pass `blobId` to `FastmailThread.readAttachment()`. */
export type FastmailAttachment = {
  filename: string;
  mimeType: string;
  size: number;
  blobId: string;
  /** True for a part the HTML body shows in place (e.g. a logo), rather than a file attached to
   * the message. */
  inline: boolean;
  /** The Content-ID the HTML body refers to it by (`<img src="cid:...">`), if any. */
  cid?: string;
};

/** Result of converting an attachment's content to Markdown. */
export type FastmailMarkdownContent = {
  /** The converted content. */
  markdown: string;
  /** The MIME type the original content was converted from. */
  sourceMimeType: string;
};

/**
 * Whether a message is mailing-list or bulk mail, from its headers. These are set by the sender, so
 * a missing marker proves nothing: plenty of automated mail has none.
 */
export type FastmailBulkSignals = {
  /** True when the message carries a List-Id, a List-Unsubscribe, or Precedence bulk/list/junk. */
  isBulk: boolean;
  /** The List-Id, without its description or angle brackets, e.g. `"news.example.com"`. */
  listId?: string;
  /** The List-Unsubscribe targets (`mailto:` or `https:` URLs). They come from the sender: never
   * open one without the user asking to unsubscribe. */
  unsubscribe?: string[];
  /** True when the sender supports one-click unsubscribe (RFC 8058). */
  oneClickUnsubscribe?: boolean;
  /** The Precedence header, lower-cased, e.g. `"bulk"` or `"list"`. */
  precedence?: string;
  /** The Auto-Submitted header when it isn't `"no"`, e.g. `"auto-generated"` (an automated
   * notification) or `"auto-replied"` (an out-of-office reply). */
  autoSubmitted?: string;
};

/** One message within a thread. */
export type FastmailMessage = {
  id: string;
  from: FastmailAddress[];
  to: FastmailAddress[];
  cc: FastmailAddress[];
  subject: string;
  receivedAt: Date;
  /** Plain-text body, if the message has one. */
  textBody?: string;
  /** HTML body, if the message has one. */
  htmlBody?: string;
  attachments: FastmailAttachment[];
  /** JMAP keywords on this message, e.g. `"$seen"`, `"$flagged"`, `"$answered"`, or a custom label
   * you or another mail client applied. */
  keywords: string[];
  /** The folders this message is in (`FastmailFolder.id`), as `listFolders()` shows them: compare
   * with a folder's `role` to tell where it is, e.g. archived (`"archive"`) or in the inbox. A
   * connection limited to one folder or search lists only the folders it can see. */
  folderIds: string[];
  /** Whether it is mailing-list or bulk mail, from its headers. */
  bulk: FastmailBulkSignals;
};

/**
 * An attachment for a draft, send or reply: new content, or one of the attachments of a message this
 * connection can open (by that message's id and the attachment's `blobId` from
 * `FastmailMessage.attachments`), which is attached without downloading it. At most 20 attachments
 * and 10 MiB in total per message.
 */
export type FastmailOutgoingAttachment =
  | { filename: string; mimeType: string; content: ArrayBuffer }
  | { fromMessageId: string; blobId: string; filename?: string };

/** Recipients and attachments of a forward. */
export type FastmailForwardOptions = {
  cc?: FastmailAddress[];
  bcc?: FastmailAddress[];
  /** Whether to include the original's attachments (and inline images). Default `true`. They count
   * towards the 10 MiB limit; pass `false` to forward only the text. */
  includeAttachments?: boolean;
  /** Further attachments to add. */
  attachments?: FastmailOutgoingAttachment[];
};

/** An attachment on a draft. */
export type FastmailDraftAttachment = { filename: string; mimeType: string; size: number };

/** Recipients, subject and body of a new draft. Every field may be left out and filled in later
 * with `FastmailDraft.update()`. Passing only `text` (no `html`) still produces a normally-formatted
 * message: a simple HTML version is derived from it automatically. */
export type FastmailDraftInput = {
  to?: FastmailAddress[];
  cc?: FastmailAddress[];
  bcc?: FastmailAddress[];
  subject?: string;
  text?: string;
  html?: string;
  attachments?: FastmailOutgoingAttachment[];
};

/** Fields to replace on a draft. Omitted fields stay as they are; `html: null` removes an explicit
 * HTML body so it is derived from `text` again. */
export type FastmailDraftPatch = {
  to?: FastmailAddress[];
  cc?: FastmailAddress[];
  bcc?: FastmailAddress[];
  subject?: string;
  text?: string;
  html?: string | null;
  /** Replaces the draft's attachments; `null` or `[]` removes them all. */
  attachments?: FastmailOutgoingAttachment[] | null;
};

/** A draft's current addressees and subject. */
export type FastmailDraftInfo = {
  /**
   * Pass this to `getDraft()`. For a draft created through this connection, or one already opened
   * with `getDraft()`, it is a stable id that stays the same when the draft is edited. For another
   * draft in the Drafts folder it is that email's Fastmail id, which is a different kind of id: it
   * is also what `getMessage()` takes, and changes when anyone edits the draft. Passing it to
   * `getDraft()` takes the draft over under a stable id, and `listDrafts()` then shows that id
   * instead.
   */
  id: string;
  to: FastmailAddress[];
  cc: FastmailAddress[];
  bcc: FastmailAddress[];
  subject: string;
  /** True for a draft created with `createReplyDraft()`: it stays in the original's thread. */
  isReply: boolean;
  /** True for a draft created with `createForwardDraft()`. */
  isForward: boolean;
  attachments: FastmailDraftAttachment[];
  /** When the draft was created or last edited. */
  updatedAt: Date;
};

/** One message in a message listing or search result, without its bodies. */
export type FastmailMessageEntry<Ref = FastmailMessageRef> = {
  /** The message's id: pass it to `getMessage()`. */
  id: string;
  /** Pass this to `getThread()`. */
  threadId: string;
  subject: string;
  /** Display-formatted sender. */
  from: string;
  receivedAt: Date;
  unread: boolean;
  /** Short plain-text preview. */
  snippet: string;
  /** JMAP keywords on this message, e.g. `"$seen"`, `"$flagged"`. */
  keywords: string[];
  /** The folders this message is in (`FastmailFolder.id`), as `listFolders()` shows them: compare
   * with a folder's `role` to tell where it is, e.g. archived (`"archive"`) or in the inbox. A
   * connection limited to one folder or search lists only the folders it can see. */
  folderIds: string[];
  /** Whether it is mailing-list or bulk mail, from its headers. */
  bulk: FastmailBulkSignals;
  /** Opens this message: the same capability `getMessage(id)` returns. */
  ref: Ref;
};

/** A new message, as delivered to a `FastmailMessageHook`. */
export type FastmailNewMessage<Thread = FastmailThread, Ref = FastmailMessageRef> = {
  /** The message, with its bodies and attachments' metadata. */
  message: FastmailMessage;
  /** The folder the hook watches, which the message arrived in; null for a saved-search binding's
   * hook. */
  folderId: string | null;
  /** The message's thread: reply, draft a reply, or organize it. Writes are queued for approval,
   * and it is released when `receiveMessage()` returns. */
  thread: Thread;
  /** The new message itself, to reply to or organize just this message. Released when
   * `receiveMessage()` returns. */
  ref: Ref;
};

/** Implemented by a gadget to receive new mail; see `FastmailDraftOnlySession.subscribeNewMessages()`. */
export interface FastmailMessageHook<Thread = FastmailThread, Ref = FastmailMessageRef> {
  /**
   * Called with each new message. Delivery is at least once and unordered, and a message this
   * throws for is retried with backoff, eight attempts in all, so key any work on
   * `entry.message.id` to keep it idempotent. Disabling the hook ends its retries.
   */
  receiveMessage(entry: FastmailNewMessage<Thread, Ref>): Promise<void>;
}

/**
 * A draft in the connected account's Drafts folder: one created through this connection, or one
 * opened with `getDraft()` that was already there. The user can open, edit and send it from
 * Fastmail; edits made there are not reflected here, and the next change made here overwrites them.
 */
export interface FastmailDraft {
  /** The draft's current addressees and subject. Throws `RESOURCE_NOT_FOUND` once it is deleted or
   * sent. */
  getMetadata(): Promise<FastmailDraftInfo>;

  /** The draft's plain-text and HTML bodies, as far as they have been written. */
  getContent(): Promise<{ text?: string; html?: string }>;

  /** Replaces the given fields, keeping the rest. A reply draft keeps its threading. */
  update(patch: FastmailDraftPatch): Promise<void>;

  /** Discards the draft without sending it. */
  delete(): Promise<void>;
}

/** A draft that can also be sent from here. */
export interface FastmailSendableDraft extends FastmailDraft {
  /**
   * Queues this draft, exactly as it currently reads, to be sent; it then leaves the Drafts folder
   * and can no longer be edited. Like `FastmailSession.send()`, this resolves once the send is
   * queued, not once the message has left the account. Requires at least one To, Cc or Bcc
   * recipient.
   */
  send(): Promise<void>;
}

/**
 * Access to one connected Fastmail account's whole mailbox, for an account that can prepare drafts
 * but not send mail: read, search and organize email, and write drafts for the user to review and
 * send from Fastmail. The account was chosen when this connection was created and cannot be changed
 * from here.
 */
export interface FastmailDraftOnlySession {
  /** Lists every folder in the mailbox. */
  listFolders(): Promise<FastmailFolder[]>;

  /**
   * Lists threads, newest first. Omit `folderId` to list across the whole mailbox.
   *
   * @example
   * ```ts
   * const cursor = await session.listThreads();
   * const threads: FastmailThreadEntry[] = [];
   * for (let page = await cursor.next(); page !== null; page = await cursor.next()) {
   *   threads.push(...page);
   * }
   * ```
   */
  listThreads(folderId?: string): Promise<Cursor<FastmailThreadEntry>>;

  /**
   * Searches threads, newest first. A string is a full-text search; an object combines structured
   * conditions (all must match). Omit `folderId` to search the whole mailbox.
   *
   * @example
   * ```ts
   * // Unread mail from a sender in the last quarter, as threads.
   * const cursor = await session.searchThreads(
   *   { from: "shop@example.com", unread: true, after: "2026-07-01" });
   * const matches: FastmailThreadEntry[] = [];
   * for (let page = await cursor.next(); page !== null; page = await cursor.next()) {
   *   matches.push(...page);
   * }
   *
   * // Plain full-text search.
   * await session.searchThreads("wedding");
   * ```
   */
  searchThreads(query: string | FastmailSearch, folderId?: string): Promise<Cursor<FastmailThreadEntry>>;

  /**
   * Changes every message of several threads (from `FastmailThreadEntry.threadId`) with one queued
   * action, one approval and one request to Fastmail: the equivalent of calling `moveToFolder()`,
   * `addKeyword()`, `removeKeyword()`, `markRead()` or `markUnread()` on each thread, e.g. to
   * archive a whole search result. 1 to 500 thread ids (repeats are ignored), at most 1000
   * messages in all. If any id is not a thread this connection can reach, the call throws
   * `RESOURCE_NOT_FOUND` and nothing is queued. Resolves when the change is queued.
   *
   * @example
   * ```ts
   * const archive = (await session.listFolders()).find(folder => folder.role === "archive")!;
   * await session.updateThreads(entries.map(entry => entry.threadId), { moveToFolder: archive.id });
   * ```
   */
  updateThreads(threadIds: string[], change: FastmailThreadChange): Promise<void>;

  /** Opens one thread by id (from a `FastmailThreadEntry.threadId`). */
  getThread(threadId: string): Promise<FastmailDraftOnlyThread>;

  /**
   * Lists individual messages, newest first, rather than one entry per thread. Omit `folderId` to
   * list across the whole mailbox.
   */
  listMessages(folderId?: string): Promise<Cursor<FastmailMessageEntry<FastmailDraftOnlyMessageRef>>>;

  /** Searches individual messages, newest first; see `FastmailSearch`. Omit `folderId` to search the whole mailbox. */
  searchMessages(
    query: string | FastmailSearch, folderId?: string,
  ): Promise<Cursor<FastmailMessageEntry<FastmailDraftOnlyMessageRef>>>;

  /** Opens one message by id (from a `FastmailMessageEntry.id` or `FastmailMessage.id`). */
  getMessage(id: string): Promise<FastmailDraftOnlyMessageRef>;

  /** Creates a new draft in the Drafts folder. Nothing is sent. */
  createDraft(draft: FastmailDraftInput): Promise<FastmailDraft>;

  /**
   * Lists every draft in the account's Drafts folder: the drafts made through this connection
   * (listed under their own stable ids), then the other drafts Fastmail holds, e.g. ones started in
   * the Fastmail app or by another client (listed under their Fastmail email ids, which
   * `getMessage()` also accepts). Each group is oldest first. Only the 100 newest emails in the
   * Drafts folder are considered for the second group.
   */
  listDrafts(): Promise<FastmailDraftInfo[]>;

  /**
   * Reopens a draft by its `FastmailDraftInfo.id`: either id kind from `listDrafts()` works. Opening
   * a draft this connection doesn't hold yet (a Fastmail email id) takes over its current content,
   * addressees, threading headers and attachments, and from then on the draft is held by this
   * connection under a new stable id (`getMetadata().id`, and what `listDrafts()` shows instead of
   * the email id). Changes to it are queued like any draft's: an edit replaces the Fastmail email,
   * so the old email id stops working and edits you or the user made in Fastmail since opening it
   * are overwritten by the next change. Throws `RESOURCE_NOT_FOUND` for an unknown id or one that
   * isn't in the Drafts folder.
   */
  getDraft(id: string): Promise<FastmailDraft>;
  /**
   * Have `hook.receiveMessage()` called with each new message that arrives in a folder: the inbox
   * unless `options.folderId` names another (a `FastmailFolder.id`, e.g. one your Fastmail rules
   * file mail into). Drafts and mail that arrived before the hook was enabled are never delivered;
   * a message moved into the folder later is not new mail. The hook starts disabled, and nothing is
   * delivered until the user enables it. Every call creates a distinct hook, so subscribe once per
   * folder to watch.
   *
   * New mail is usually delivered within seconds, through Fastmail's JMAP push; on a deployment
   * Fastmail can't reach, or while push is being set up, it is checked for every two minutes.
   *
   * `hook` must be a persistent stub: from `executeCode`, create it with
   * `env.MY_GADGET[restore](params)` on the Gadget's binding; inside the Gadget, with
   * `this.ctx.restore(params)`. The Gadget's `[restore]()` receives those `params` for every
   * delivery, so they can tell its subscriptions apart. The restored target is a separate
   * object; pass it what it needs from `[restore]()`, such as `this`, the Gadget.
   *
   * @example
   * // server.js
   * import { DurableObject, RpcTarget, restore } from "cloudflare:workers";
   * export class Gadget extends DurableObject {
   *   async [restore](params) {
   *     if (params.type === "fastmail") return new Triage();
   *     throw new TypeError(`Unknown restore type: ${params.type}`);
   *   }
   * }
   * class Triage extends RpcTarget {
   *   async receiveMessage({ message, thread }) {
   *     if (/urgent/i.test(message.subject)) await thread.addKeyword("$flagged");
   *   }
   * }
   *
   * // executeCode
   * import { restore } from "cloudflare:workers";
   * export default async function(self, env) {
   *   await env.FASTMAIL.subscribeNewMessages(await env.MY_GADGET[restore]({ type: "fastmail" }));
   * }
   */
  subscribeNewMessages(
    hook: RpcStub<FastmailMessageHook<FastmailDraftOnlyThread, FastmailDraftOnlyMessageRef>>,
    options?: { folderId?: string },
  ): Promise<void>;
}

/**
 * Read-write access to one connected Fastmail account's whole mailbox, including sending mail. The
 * account was chosen when this connection was created and cannot be changed from here.
 */
export interface FastmailSession extends FastmailDraftOnlySession {
  /** Opens one thread by id (from a `FastmailThreadEntry.threadId`). */
  getThread(threadId: string): Promise<FastmailThread>;

  /** Creates a new draft in the Drafts folder. Nothing is sent until you call its `send()`. */
  createDraft(draft: FastmailDraftInput): Promise<FastmailSendableDraft>;

  /** Reopens a draft by its `FastmailDraftInfo.id`; see `FastmailDraftOnlySession.getDraft()`. */
  getDraft(id: string): Promise<FastmailSendableDraft>;
  /** Opens one message by id (from a `FastmailMessageEntry.id` or `FastmailMessage.id`). */
  getMessage(id: string): Promise<FastmailMessageRef>;

  /** As `FastmailDraftOnlySession.listMessages()`, with messages that can also be replied to. */
  listMessages(folderId?: string): Promise<Cursor<FastmailMessageEntry>>;

  /** As `FastmailDraftOnlySession.searchMessages()`, with messages that can also be replied to. */
  searchMessages(query: string | FastmailSearch, folderId?: string): Promise<Cursor<FastmailMessageEntry>>;

  /** As `FastmailDraftOnlySession.subscribeNewMessages()`, with a thread and message that can also reply. */
  subscribeNewMessages(
    hook: RpcStub<FastmailMessageHook<FastmailThread, FastmailMessageRef>>, options?: { folderId?: string },
  ): Promise<void>;

  /**
   * Queues a new message to send. Like any other action here, sending may be held for approval
   * before it actually happens — this resolves once the send is queued, not once the message has
   * actually left the account, and there is no way to learn the resulting message's id from this
   * call. Throws with code `SUBMISSION_NOT_AUTHORIZED` if the connected account's API token was not
   * granted Email submission scope — check for that before calling if you need to handle it
   * gracefully, since not every connected token can send. Passing only `text` (no `html`) still
   * sends a normally-formatted message: a simple HTML version is derived from it automatically.
   */
  send(
    to: FastmailAddress[],
    subject: string,
    body: { text?: string; html?: string },
    options?: { cc?: FastmailAddress[]; bcc?: FastmailAddress[]; attachments?: FastmailOutgoingAttachment[] },
  ): Promise<void>;
}

/** One email thread, with its messages, in an account that can prepare drafts but not send. */
export interface FastmailDraftOnlyThread {
  /** All messages in this thread, oldest first. */
  messages(): Promise<FastmailMessage[]>;

  /**
   * Creates a draft reply to this thread's most recent message, threaded and addressed the same
   * way `FastmailThread.reply()` addresses a reply, with a `Re:` subject. Nothing is sent.
   */
  createReplyDraft(
    body: { text?: string; html?: string },
    options?: { replyAll?: boolean; cc?: FastmailAddress[]; bcc?: FastmailAddress[]; attachments?: FastmailOutgoingAttachment[] },
  ): Promise<FastmailDraft>;

  /** Downloads one attachment's content, by the `blobId` from `FastmailMessage.attachments`. */
  readAttachment(blobId: string): Promise<ArrayBuffer>;

  /**
   * Downloads one attachment's content and converts it to Markdown -- HTML, PDF, and common
   * office/document formats (Word, Excel, OpenDocument, Apple Numbers) become readable text. See
   * `readAttachment()` for how `blobId` is resolved. Throws with code `UNSUPPORTED_FOR_MARKDOWN`
   * if the attachment's `mimeType` cannot be converted, or `TOO_LARGE_FOR_MARKDOWN` if it is too
   * large -- check `FastmailMessage.attachments` first, or call `readAttachment()` instead, if
   * either is a possibility.
   */
  readAttachmentAsMarkdown(blobId: string): Promise<FastmailMarkdownContent>;

  /**
   * Moves every message in this thread into `folderId` (from `FastmailFolder.id`). Use
   * `listFolders()` and its `role` field to find the right target — e.g. the folder with
   * `role: "archive"` or `role: "trash"` — there is no separate archive()/trash() shortcut.
   */
  moveToFolder(folderId: string): Promise<void>;

  /** Adds a JMAP keyword (e.g. `"$flagged"`, or a custom label) to every message in this thread. */
  addKeyword(keyword: string): Promise<void>;

  /** Removes a JMAP keyword from every message in this thread. */
  removeKeyword(keyword: string): Promise<void>;

  /** Marks every message in this thread as read (adds the `"$seen"` keyword). */
  markRead(): Promise<void>;

  /** Marks every message in this thread as unread (removes the `"$seen"` keyword). */
  markUnread(): Promise<void>;
}

/** One email thread, with its messages. */
export interface FastmailThread extends FastmailDraftOnlyThread {
  /**
   * Queues a reply to this thread's most recent message, threaded properly (`In-Reply-To` and
   * `References` are set, the subject gets a `Re:` prefix, and the original is marked
   * `"$answered"` once sent). It goes to the original's Reply-To/From address; when the most recent
   * message is one you sent, it goes to that message's recipients instead. `replyAll` also includes
   * the original's other To/Cc recipients (never your own address). Like `send()`, this resolves
   * once the reply is queued for approval, and throws `SUBMISSION_NOT_AUTHORIZED` if the token
   * cannot send. Prefer this over `send()` whenever you are answering an existing message.
   * Passing only `text` (no `html`) still sends a normally-formatted message: a simple HTML
   * version is derived from it automatically.
   *
   * @example
   * ```ts
   * const thread = await session.getThread(entry.threadId);
   * await thread.reply({ text: "Thanks, see you then!" });
   * ```
   */
  reply(
    body: { text?: string; html?: string },
    options?: { replyAll?: boolean; cc?: FastmailAddress[]; bcc?: FastmailAddress[]; attachments?: FastmailOutgoingAttachment[] },
  ): Promise<void>;

  /**
   * Creates a draft reply to this thread's most recent message, addressed and threaded exactly as
   * `reply()` would send it. Nothing is sent until you call its `send()`.
   */
  createReplyDraft(
    body: { text?: string; html?: string },
    options?: { replyAll?: boolean; cc?: FastmailAddress[]; bcc?: FastmailAddress[]; attachments?: FastmailOutgoingAttachment[] },
  ): Promise<FastmailSendableDraft>;
}

/**
 * One message, for an account that can prepare drafts but not send: read it, organize just this
 * message, or draft a reply to it.
 */
export interface FastmailDraftOnlyMessageRef {
  /** The message, with its bodies and attachments' metadata. */
  read(): Promise<FastmailMessage>;
  /** Every raw header field of the message, in order (e.g. `List-Id`, `Received`, `Authentication-Results`). */
  getHeaders(): Promise<{ name: string; value: string }[]>;
  /** The message's thread, as far as this connection can see it. */
  thread(): Promise<FastmailDraftOnlyThread>;
  /** Downloads one of this message's attachments, by the `blobId` from `FastmailMessage.attachments`. */
  readAttachment(blobId: string): Promise<ArrayBuffer>;
  /** As `FastmailDraftOnlyThread.readAttachmentAsMarkdown()`, for one of this message's attachments. */
  readAttachmentAsMarkdown(blobId: string): Promise<FastmailMarkdownContent>;
  /** Moves just this message into `folderId` (from `FastmailFolder.id`). */
  moveToFolder(folderId: string): Promise<void>;
  /** Adds a JMAP keyword (e.g. `"$flagged"`) to just this message. */
  addKeyword(keyword: string): Promise<void>;
  /** Removes a JMAP keyword from just this message. */
  removeKeyword(keyword: string): Promise<void>;
  /** Marks just this message as read. */
  markRead(): Promise<void>;
  /** Marks just this message as unread. */
  markUnread(): Promise<void>;
  /**
   * Creates a draft reply to this message (not necessarily the thread's newest), threaded and
   * addressed as `FastmailMessageRef.reply()` would send it. Nothing is sent.
   */
  createReplyDraft(
    body: { text?: string; html?: string },
    options?: { replyAll?: boolean; cc?: FastmailAddress[]; bcc?: FastmailAddress[]; attachments?: FastmailOutgoingAttachment[] },
  ): Promise<FastmailDraft>;
  /**
   * Creates a draft forwarding this message to `to`: subject "Fwd: ...", your optional note, then
   * the original under a "Forwarded message" block with its From, Date, Subject and To, in plain
   * text and HTML, with the original's attachments. Nothing is sent.
   */
  createForwardDraft(
    to: FastmailAddress[], body?: { text?: string; html?: string }, options?: FastmailForwardOptions,
  ): Promise<FastmailDraft>;
}

/** One message: read it, organize just this message, reply to it, or forward it. */
export interface FastmailMessageRef extends FastmailDraftOnlyMessageRef {
  /** The message's thread, as far as this connection can see it. */
  thread(): Promise<FastmailThread>;
  /**
   * Queues a reply to this message (not necessarily the thread's newest), threaded properly and
   * addressed as `FastmailThread.reply()` describes. Resolves once the reply is queued.
   */
  reply(
    body: { text?: string; html?: string },
    options?: { replyAll?: boolean; cc?: FastmailAddress[]; bcc?: FastmailAddress[]; attachments?: FastmailOutgoingAttachment[] },
  ): Promise<void>;
  /** As `FastmailDraftOnlyMessageRef.createReplyDraft()`, with a draft that can also be sent. */
  createReplyDraft(
    body: { text?: string; html?: string },
    options?: { replyAll?: boolean; cc?: FastmailAddress[]; bcc?: FastmailAddress[]; attachments?: FastmailOutgoingAttachment[] },
  ): Promise<FastmailSendableDraft>;
  /**
   * Queues this message to be forwarded to `to`, as `createForwardDraft()` describes; the original
   * is marked `"$forwarded"` once it is sent. Resolves once the forward is queued.
   *
   * @example
   * ```ts
   * const message = await session.getMessage(id);
   * await message.forward([{ email: "accountant@example.com" }], { text: "Invoice for October." });
   * ```
   */
  forward(
    to: FastmailAddress[], body?: { text?: string; html?: string }, options?: FastmailForwardOptions,
  ): Promise<void>;
  /** As `FastmailDraftOnlyMessageRef.createForwardDraft()`, with a draft that can also be sent. */
  createForwardDraft(
    to: FastmailAddress[], body?: { text?: string; html?: string }, options?: FastmailForwardOptions,
  ): Promise<FastmailSendableDraft>;
}

/**
 * Access to part of one connected Fastmail account: the messages in one folder, or the messages
 * matching one saved search, chosen when this connection was created. Nothing else in the mailbox
 * is visible: listings, searches and hooks cover only those messages, and a thread shows only its
 * messages that are within scope. A message that leaves the folder, or stops matching the search,
 * leaves scope too. This connection can't write new mail, but can reply to messages in scope (as
 * drafts, for this account).
 */
export interface FastmailScopedDraftOnlySession {
  /**
   * Lists the folders this connection may use: its own folder, and the Inbox, Archive, Trash and
   * Junk folders to move mail into. A parent folder outside that list shows as `parentId: null`.
   */
  listFolders(): Promise<FastmailFolder[]>;
  /** Lists threads in scope, newest first. `folderId` narrows a saved search to one folder. */
  listThreads(folderId?: string): Promise<Cursor<FastmailThreadEntry>>;
  /** Searches threads in scope, newest first; a string is a full-text search, see `FastmailSearch`. */
  searchThreads(query: string | FastmailSearch, folderId?: string): Promise<Cursor<FastmailThreadEntry>>;
  /** Opens one thread by id, showing only its messages in scope. */
  getThread(threadId: string): Promise<FastmailDraftOnlyThread>;
  /** Lists messages in scope, newest first. */
  listMessages(folderId?: string): Promise<Cursor<FastmailMessageEntry<FastmailDraftOnlyMessageRef>>>;
  /** Searches messages in scope, newest first; see `FastmailSearch`. */
  searchMessages(
    query: string | FastmailSearch, folderId?: string,
  ): Promise<Cursor<FastmailMessageEntry<FastmailDraftOnlyMessageRef>>>;
  /**
   * Changes every message of several threads in scope with one queued action. See
   * `FastmailDraftOnlySession.updateThreads()`; a thread with no message in scope is refused like
   * a missing one, and the change can only file mail into the folders `listFolders()` shows.
   */
  updateThreads(threadIds: string[], change: FastmailThreadChange): Promise<void>;
  /** Opens one message in scope by id. */
  getMessage(id: string): Promise<FastmailDraftOnlyMessageRef>;
  /**
   * Lists the drafts created through this connection that are still drafts, oldest first. Other
   * drafts in the Drafts folder are outside this connection's scope and are not listed.
   */
  listDrafts(): Promise<FastmailDraftInfo[]>;
  /** Reopens a draft by its `FastmailDraftInfo.id`. */
  getDraft(id: string): Promise<FastmailDraft>;
  /**
   * Have `hook.receiveMessage()` called with each new message arriving in scope: in the folder, or
   * matching the saved search. Otherwise as `FastmailDraftOnlySession.subscribeNewMessages()`.
   */
  subscribeNewMessages(
    hook: RpcStub<FastmailMessageHook<FastmailDraftOnlyThread, FastmailDraftOnlyMessageRef>>,
  ): Promise<void>;
}

/** As `FastmailScopedDraftOnlySession`, for an account that can also send replies. */
export interface FastmailScopedSession extends FastmailScopedDraftOnlySession {
  /** Opens one thread by id, showing only its messages in scope. */
  getThread(threadId: string): Promise<FastmailThread>;
  /** Lists messages in scope, newest first. */
  listMessages(folderId?: string): Promise<Cursor<FastmailMessageEntry>>;
  /** As `FastmailScopedDraftOnlySession.searchMessages()`, with messages that can also be replied to. */
  searchMessages(query: string | FastmailSearch, folderId?: string): Promise<Cursor<FastmailMessageEntry>>;
  /** Opens one message in scope by id. */
  getMessage(id: string): Promise<FastmailMessageRef>;
  /** Reopens a draft by its `FastmailDraftInfo.id`. */
  getDraft(id: string): Promise<FastmailSendableDraft>;
  /** As `FastmailScopedDraftOnlySession.subscribeNewMessages()`, with a thread and message that can also reply. */
  subscribeNewMessages(hook: RpcStub<FastmailMessageHook<FastmailThread, FastmailMessageRef>>): Promise<void>;
}

/** One email address of a contact. */
export type FastmailContactEmail = {
  address: string;
  /** The contact's own label for it, or its context (`"work"`, `"private"`), when set. */
  label?: string;
};

/** One phone number of a contact. */
export type FastmailContactPhone = {
  number: string;
  /** The contact's own label for it, or its context and features (`"work, mobile"`), when set. */
  label?: string;
};

/**
 * One contact card. Emails and phone numbers come most-preferred first. Contact groups are not
 * contacts: see `FastmailContactGroup`.
 */
export type FastmailContact = {
  /** Pass this to `getContact()`. */
  id: string;
  /** JSContact kind: usually `"individual"` (a person) or `"org"` (an organization). */
  kind: string;
  /** Display name: the full name, else the name parts, else the organization or first address. */
  name: string;
  givenName?: string;
  surname?: string;
  nicknames: string[];
  emails: FastmailContactEmail[];
  phones: FastmailContactPhone[];
  /** Organization names, with any units, e.g. `"Acme / Research"`. */
  organizations: string[];
  /** Job titles and roles. */
  titles: string[];
  /** Postal addresses, one line each. */
  addresses: string[];
  /** Websites and online-service handles. */
  online: string[];
  /** `YYYY-MM-DD`, or `--MM-DD` when the year is unknown. */
  birthday?: string;
  notes?: string;
};

/** One contact group: a named list of contacts. */
export type FastmailContactGroup = {
  /** Pass this to `listContacts()`/`searchContacts()`'s `groupId`. */
  id: string;
  name: string;
  memberCount: number;
};

/** A contact to create with `createContact()`; change an existing one with `FastmailContactChanges`. */
export type FastmailContactInput = {
  /** `"individual"` (a person, the default for a new contact) or `"org"` (an organization). */
  kind?: "individual" | "org";
  /** The full display name; when left out, the name parts make it up. */
  name?: string;
  givenName?: string;
  surname?: string;
  nicknames?: string[];
  /** A `label` of `"work"` or `"private"` is stored as that context; anything else as a label. */
  emails?: FastmailContactEmail[];
  /** As `emails`; labels `"mobile"`, `"voice"`, `"fax"`, `"text"`, `"pager"`, `"video"` are phone
   * features, and may be combined with a context, e.g. `"work, mobile"`. */
  phones?: FastmailContactPhone[];
  /** Organization names; `"Acme / Research"` is the unit Research of Acme. */
  organizations?: string[];
  titles?: string[];
  /** Postal addresses, one line each. */
  addresses?: string[];
  /** Websites (`https://...`) or online-service handles. */
  online?: string[];
  /** `YYYY-MM-DD`, or `--MM-DD` when the year is unknown. */
  birthday?: string;
  notes?: string;
};

/** Entries to add to, and entries to remove from, one list of a contact. */
export type FastmailContactListChange<Add, Remove = string> = {
  /** Appended to the contact's entries; a value already there is not added again. */
  add?: Add[];
  /** Removes the matching entries. A value that isn't on the contact when you call is refused. */
  remove?: Remove[];
};

/**
 * Changes to one existing contact, for `updateContact()`. Only what you name changes: entries you
 * don't remove stay exactly as they are, including details `FastmailContact` doesn't show.
 * Removals are matched against the contact as it is when the change is approved, not when you ask,
 * so edits made in between are kept and a value already gone is simply skipped.
 */
export type FastmailContactChanges = {
  kind?: "individual" | "org";
  /** The full display name; `null` removes it. */
  name?: string | null;
  /** Replaces the given-name part of the name (other parts such as a prefix stay); `null` removes it. */
  givenName?: string | null;
  /** As `givenName`, for the surname. */
  surname?: string | null;
  /** `YYYY-MM-DD`, or `--MM-DD` when the year is unknown; `null` removes it. */
  birthday?: string | null;
  /** Replaces all notes with this one; `null` removes them. */
  notes?: string | null;
  /** `remove` takes an address (case-insensitive). Labels as in `FastmailContactInput.emails`. */
  emails?: FastmailContactListChange<FastmailContactEmail>;
  /** `remove` takes a number; it matches by its digits and a leading `+`, ignoring spacing. */
  phones?: FastmailContactListChange<FastmailContactPhone>;
  /** `remove` takes the exact string `FastmailContact.nicknames` shows. */
  nicknames?: FastmailContactListChange<string>;
  /** `remove` takes the exact string `FastmailContact.organizations` shows, e.g. `"Acme / Research"`. */
  organizations?: FastmailContactListChange<string>;
  /** `remove` takes the exact string `FastmailContact.titles` shows. */
  titles?: FastmailContactListChange<string>;
  /** `remove` takes the exact line `FastmailContact.addresses` shows. */
  addresses?: FastmailContactListChange<string>;
  /** `remove` takes the exact string `FastmailContact.online` shows. */
  online?: FastmailContactListChange<string>;
};

/**
 * Access to the contacts of one connected Fastmail account. Listings are in Fastmail's order.
 *
 * Changes are queued for the user's approval and resolve once queued, not once applied: they show
 * up in listings only after approval. Creating, editing and group membership changes may be
 * auto-approved if the user allows it; deleting always waits for a person. None can be reverted
 * through this connection.
 */
export interface FastmailContactsSession {
  /** Lists the account's contact groups. */
  listGroups(): Promise<FastmailContactGroup[]>;
  /** Lists every contact, or only the members of `groupId`. */
  listContacts(groupId?: string): Promise<Cursor<FastmailContact>>;
  /**
   * Searches contacts by any text on the card (name, email, phone, organization, address, notes),
   * optionally only within `groupId`.
   */
  searchContacts(query: string, groupId?: string): Promise<Cursor<FastmailContact>>;
  /** Opens one contact by id. */
  getContact(id: string): Promise<FastmailContact>;
  /** Queues creating a contact in the default address book, and adding it to `groupId` if given. */
  createContact(contact: FastmailContactInput, groupId?: string): Promise<void>;
  /**
   * Queues changing a contact; entries are added and removed one by one, see `FastmailContactChanges`.
   * Refused if a value to remove isn't on the contact.
   */
  updateContact(id: string, changes: FastmailContactChanges): Promise<void>;
  /** Queues deleting a contact from the account. Always needs a person's approval. */
  deleteContact(id: string): Promise<void>;
  /** Queues adding a contact to a group. */
  addToGroup(contactId: string, groupId: string): Promise<void>;
  /** Queues removing a contact from a group; the contact itself stays. */
  removeFromGroup(contactId: string, groupId: string): Promise<void>;
}

/**
 * Access to one contact group of a connected Fastmail account, chosen when this connection was
 * created. Only the group's current members are visible: a contact removed from the group leaves
 * scope too. Changes are queued for approval as for `FastmailContactsSession`. There is no
 * `deleteContact()`: deleting a contact from the account is outside a group connection's reach;
 * `removeFromGroup()` takes a member out of the group.
 */
export interface FastmailGroupContactsSession {
  /** This connection's group, with its current name and size. */
  getGroup(): Promise<FastmailContactGroup>;
  /** Lists the group's members. */
  listContacts(): Promise<Cursor<FastmailContact>>;
  /** Searches the group's members by any text on their cards. */
  searchContacts(query: string): Promise<Cursor<FastmailContact>>;
  /** Opens one of the group's members by id. */
  getContact(id: string): Promise<FastmailContact>;
  /** Queues creating a contact in the default address book as a member of this group. */
  createContact(contact: FastmailContactInput): Promise<void>;
  /**
   * Queues changing one of the group's members; entries are added and removed one by one, see
   * `FastmailContactChanges`. Refused if a value to remove isn't on the contact.
   */
  updateContact(id: string, changes: FastmailContactChanges): Promise<void>;
  /** Queues removing a member from this group; the contact itself stays in the account. */
  removeFromGroup(contactId: string): Promise<void>;
}
