/**
 * Caching and simulation for the session (write-gatekeeper skill, Phase 2: "Caching" and
 * "Simulation").
 *
 * Folder listings are cached on a short TTL, the same approach as gatekeeper-jottacloud's metadata
 * cache. A thread mutation (`moveToFolder`/`addKeyword`/`removeKeyword`/`markRead`/`markUnread`)
 * patches every message in the thread with one `Email/set update` call once approved; until then,
 * its pending patch is recorded once per action id (`getPendingAction`/`setPendingAction`) so
 * `applyAction()`/`rejectAction()` know what to send (or discard), and — for keyword patches only,
 * since `FastmailMessage` surfaces keywords but not folder membership — a simulated keyword overlay
 * per email id lets `messages()` reflect a caller's own not-yet-approved edit immediately.
 *
 * Only the single most recently submitted pending patch per email id is tracked as "simulated" — a
 * second patch submitted before the first resolves simply becomes the new simulated overlay for
 * that email, and resolving the first only clears it if it is still the latest one. Good enough for
 * one mailbox binding, where concurrent pending patches on the same message are rare; documented
 * here rather than hidden, per the skill's guidance on simulation gaps.
 */

import type { SendEmailParams } from "./fastmail-api";
import type { JmapMailboxObject } from "./fastmail-types";

/** The subset of `DurableObjectStorage["kv"]` this module needs, for easy unit testing. */
export type CacheKv = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): boolean | void;
};

/** How long a fetched folder list is trusted before re-fetching. */
export const FOLDER_CACHE_TTL_MS = 30_000;

const FOLDERS_KEY = "cache:folders";

type CachedFolders = { folders: JmapMailboxObject[]; fetchedAt: number };

export function getCachedFolders(kv: CacheKv, now: number): JmapMailboxObject[] | undefined {
  const cached = kv.get<CachedFolders>(FOLDERS_KEY);
  if (!cached || now - cached.fetchedAt >= FOLDER_CACHE_TTL_MS) return undefined;
  return cached.folders;
}

export function putCachedFolders(kv: CacheKv, folders: JmapMailboxObject[], now: number): void {
  kv.put<CachedFolders>(FOLDERS_KEY, { folders, fetchedAt: now });
}

/** Converted Markdown above this length (in UTF-16 code units) is not cached. */
export const ATTACHMENT_MARKDOWN_MAX_CHARS = 2_000_000;

type CachedAttachmentMarkdown = { markdown: string; sourceMimeType: string };

function attachmentMarkdownKey(blobId: string): string {
  return `cache:markdown:${blobId}`;
}

/**
 * A `blobId`'s content never changes (unlike a Jottacloud file's `md5`-keyed cache), so this has
 * no TTL -- only the size cap `putCachedAttachmentMarkdown` applies, for the same reason
 * `putCachedContent`-style caches elsewhere withhold oversized values.
 */
export function getCachedAttachmentMarkdown(kv: CacheKv, blobId: string): CachedAttachmentMarkdown | undefined {
  return kv.get<CachedAttachmentMarkdown>(attachmentMarkdownKey(blobId));
}

export function putCachedAttachmentMarkdown(
  kv: CacheKv, blobId: string, value: CachedAttachmentMarkdown,
): void {
  if (value.markdown.length > ATTACHMENT_MARKDOWN_MAX_CHARS) return;
  kv.put<CachedAttachmentMarkdown>(attachmentMarkdownKey(blobId), value);
}

/**
 * A deferred, not-yet-approved side effect. Either a JMAP `Email/set update` patch applied to every
 * message id in a thread (`moveToFolder`/`addKeyword`/`removeKeyword`/`markRead`/`markUnread`), or a
 * queued `send()` — sending is irreversible and has nothing to simulate, so (unlike a thread patch)
 * it carries no keyword overlay; `FastmailSession.send()` returns once this is queued, same as
 * `JottacloudFileSession.write()` does, not once it is actually sent.
 */
export type PendingAction =
  | { kind: "patch"; emailIds: string[]; patch: Record<string, unknown> }
  | {
      kind: "send";
      params: SendEmailParams;
      /** For a reply: the email being answered, marked `$answered` once the reply is sent. */
      answersEmailId?: string;
    };

function pendingActionKey(actionId: number): string {
  return `action:pending:${actionId}`;
}

export function getPendingAction(kv: CacheKv, actionId: number): PendingAction | undefined {
  return kv.get<PendingAction>(pendingActionKey(actionId));
}

export function setPendingAction(kv: CacheKv, actionId: number, pending: PendingAction): void {
  kv.put<PendingAction>(pendingActionKey(actionId), pending);
}

export function deletePendingAction(kv: CacheKv, actionId: number): void {
  kv.delete(pendingActionKey(actionId));
}

/** A simulated per-keyword patch fragment for one email: `true` to show it added, `false` to show
 * it removed, pending approval. */
type SimulatedKeywords = { actionId: number; keywords: Record<string, boolean> };

function simulatedKeywordsKey(emailId: string): string {
  return `sim:keywords:${emailId}`;
}

export function getSimulatedKeywords(kv: CacheKv, emailId: string): Record<string, boolean> | undefined {
  return kv.get<SimulatedKeywords>(simulatedKeywordsKey(emailId))?.keywords;
}

export function setSimulatedKeywords(
  kv: CacheKv, emailId: string, actionId: number, keywords: Record<string, boolean>,
): void {
  kv.put<SimulatedKeywords>(simulatedKeywordsKey(emailId), { actionId, keywords });
}

/** Idempotent: only clears the overlay if `actionId` is still the latest pending patch for this
 * email id, so resolving an older, already-superseded patch leaves a newer one's simulation alone. */
export function clearSimulatedKeywordsIfLatest(kv: CacheKv, emailId: string, actionId: number): void {
  const current = kv.get<SimulatedKeywords>(simulatedKeywordsKey(emailId));
  if (current?.actionId === actionId) kv.delete(simulatedKeywordsKey(emailId));
}

/** Merges a keyword-set/keyword-unset simulated overlay into a message's real (or cached) keyword
 * set, for display before the underlying patch is approved and applied. */
export function mergeSimulatedKeywords(
  keywords: Record<string, boolean>, overlay: Record<string, boolean> | undefined,
): Record<string, boolean> {
  if (!overlay) return keywords;
  const merged = { ...keywords };
  for (const [keyword, present] of Object.entries(overlay)) {
    if (present) merged[keyword] = true;
    else delete merged[keyword];
  }
  return merged;
}
