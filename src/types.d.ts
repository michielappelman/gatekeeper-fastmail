import type { RpcStub } from "cloudflare:workers";
import type { Cursor } from "@gadgets/workshop-shared/gatekeeper";

/** Forward-only paginated results. Call `next()` repeatedly on the same cursor to fetch successive
 * batches, until it returns `null` — an empty array is not exhaustion, only `null` is. Dispose the
 * cursor when finished, including when stopping early. */
export type { Cursor };

/** One of Fastmail's standard system folder roles (JMAP Mailbox `role`), when set. */
export type FastmailFolderRole = "inbox" | "sent" | "drafts" | "trash" | "junk" | "archive";

/** One Fastmail folder (a JMAP Mailbox — closer to an IMAP folder than a Gmail label: an email can
 * still live in more than one Mailbox at once). */
export type FastmailFolder = {
  /** Pass this to `listThreads()`/`searchThreads()`'s `folderId`, or `moveToFolder()`. */
  id: string;
  name: string;
  /** Set for Fastmail's built-in system folders (Inbox, Sent, Drafts, Trash, Junk, Archive); null
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

export type FastmailAddress = { email: string; name?: string };

/** One attachment on a message. Pass `blobId` to `FastmailThread.readAttachment()`. */
export type FastmailAttachment = {
  filename: string;
  mimeType: string;
  size: number;
  blobId: string;
};

/** Result of converting an attachment's content to Markdown. */
export type FastmailMarkdownContent = {
  /** The converted content. */
  markdown: string;
  /** The MIME type the original content was converted from. */
  sourceMimeType: string;
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
};

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
};

/** A draft's current addressees and subject. */
export type FastmailDraftInfo = {
  /** Pass this to `getDraft()`. It stays the same when the draft is edited. */
  id: string;
  to: FastmailAddress[];
  cc: FastmailAddress[];
  bcc: FastmailAddress[];
  subject: string;
  /** True for a draft created with `createReplyDraft()`: it stays in the original's thread. */
  isReply: boolean;
  /** When the draft was created or last edited. */
  updatedAt: Date;
};

/** A new message, as delivered to a `FastmailMessageHook`. */
export type FastmailNewMessage<Thread = FastmailThread> = {
  /** The message, with its bodies and attachments' metadata. */
  message: FastmailMessage;
  /** The folder the hook watches, which the message arrived in. */
  folderId: string;
  /** The message's thread: reply, draft a reply, or organize it. Writes are queued for approval,
   * and it is released when `receiveMessage()` returns. */
  thread: Thread;
};

/** Implemented by a gadget to receive new mail; see `FastmailDraftOnlySession.subscribeNewMessages()`. */
export interface FastmailMessageHook<Thread = FastmailThread> {
  /**
   * Called with each new message. Delivery is at least once and unordered, and a message this
   * throws for is retried with backoff, eight attempts in all, so key any work on
   * `entry.message.id` to keep it idempotent. Disabling the hook ends its retries.
   */
  receiveMessage(entry: FastmailNewMessage<Thread>): Promise<void>;
}

/**
 * A draft in the connected account's Drafts folder, created through this connection. The user can
 * open, edit and send it from Fastmail; edits made there are not reflected here.
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
   * Full-text searches threads, newest first. Omit `folderId` to search the whole mailbox.
   *
   * @example
   * ```ts
   * const cursor = await session.searchThreads("wedding");
   * const matches: FastmailThreadEntry[] = [];
   * for (let page = await cursor.next(); page !== null; page = await cursor.next()) {
   *   matches.push(...page);
   * }
   * ```
   */
  searchThreads(query: string, folderId?: string): Promise<Cursor<FastmailThreadEntry>>;

  /** Opens one thread by id (from a `FastmailThreadEntry.threadId`). */
  getThread(threadId: string): Promise<FastmailDraftOnlyThread>;

  /** Creates a new draft in the Drafts folder. Nothing is sent. */
  createDraft(draft: FastmailDraftInput): Promise<FastmailDraft>;

  /** Lists the drafts created through this connection that are still drafts, oldest first. */
  listDrafts(): Promise<FastmailDraftInfo[]>;

  /** Reopens a draft by its `FastmailDraftInfo.id`. */
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
    hook: RpcStub<FastmailMessageHook<FastmailDraftOnlyThread>>, options?: { folderId?: string },
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

  /** Reopens a draft by its `FastmailDraftInfo.id`. */
  getDraft(id: string): Promise<FastmailSendableDraft>;
  /** As `FastmailDraftOnlySession.subscribeNewMessages()`, with a thread that can also reply. */
  subscribeNewMessages(
    hook: RpcStub<FastmailMessageHook<FastmailThread>>, options?: { folderId?: string },
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
    options?: { cc?: FastmailAddress[]; bcc?: FastmailAddress[] },
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
    options?: { replyAll?: boolean; cc?: FastmailAddress[]; bcc?: FastmailAddress[] },
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
    options?: { replyAll?: boolean; cc?: FastmailAddress[]; bcc?: FastmailAddress[] },
  ): Promise<void>;

  /**
   * Creates a draft reply to this thread's most recent message, addressed and threaded exactly as
   * `reply()` would send it. Nothing is sent until you call its `send()`.
   */
  createReplyDraft(
    body: { text?: string; html?: string },
    options?: { replyAll?: boolean; cc?: FastmailAddress[]; bcc?: FastmailAddress[] },
  ): Promise<FastmailSendableDraft>;
}
