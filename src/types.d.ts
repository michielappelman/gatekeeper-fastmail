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

/**
 * Read-write access to one connected Fastmail account's whole mailbox. The account was chosen when
 * this connection was created and cannot be changed from here.
 */
export interface FastmailSession {
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
  getThread(threadId: string): Promise<FastmailThread>;

  /**
   * Queues a new message to send. Like any other action here, sending may be held for approval
   * before it actually happens — this resolves once the send is queued, not once the message has
   * actually left the account, and there is no way to learn the resulting message's id from this
   * call. Throws with code `SUBMISSION_NOT_AUTHORIZED` if the connected account's API token was not
   * granted Email submission scope — check for that before calling if you need to handle it
   * gracefully, since not every connected token can send.
   */
  send(
    to: FastmailAddress[],
    subject: string,
    body: { text?: string; html?: string },
    options?: { cc?: FastmailAddress[]; bcc?: FastmailAddress[] },
  ): Promise<void>;
}

/** One email thread, with its messages. */
export interface FastmailThread {
  /** All messages in this thread, oldest first. */
  messages(): Promise<FastmailMessage[]>;

  /** Downloads one attachment's content, by the `blobId` from `FastmailMessage.attachments`. */
  readAttachment(blobId: string): Promise<ArrayBuffer>;

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
