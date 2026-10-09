/**
 * Draft simulation and application (see `./cache.ts` for the record layout). Kept apart from
 * `./fastmail.ts` so the revision ordering rules can be tested without a Durable Object.
 */

import {
  currentDraftRevision,
  deleteDraftRecord,
  getDraftRecord,
  putDraftRecord,
  type CacheKv,
  type DraftContent,
  type DraftRecord,
} from "./cache";
import { FastmailError } from "./errors";
import {
  destroyEmails,
  findDraftsMailboxId,
  resolveSendContext,
  sendEmail,
  updateEmails,
  writeDraft,
  type FastmailAccountInfo,
} from "./fastmail-api";
import type { JmapEmailAddress } from "./fastmail-types";
import type { FastmailAddress, FastmailDraftInfo } from "./types";

/** What applying a revision needs from the stored grant. */
export type DraftGrant = Pick<FastmailAccountInfo, "apiUrl" | "accountId" | "hasSubmission"> & {
  apiToken: string;
};

/** The draft's current content, or `RESOURCE_NOT_FOUND` if it was deleted, sent, or never existed. */
export function currentDraft(
  kv: CacheKv, draftId: string,
): { record: DraftRecord; content: DraftContent; at: number } {
  const record = getDraftRecord(kv, draftId);
  const current = record && currentDraftRevision(record);
  if (!record || !current || current.revision.kind !== "content") {
    const gone = current?.revision.kind === "sent" ? "has been sent" : "no longer exists";
    throw new FastmailError("RESOURCE_NOT_FOUND", `This Fastmail draft ${gone}.`);
  }
  return { record, content: current.revision.content, at: current.revision.at };
}

function toAgentAddresses(addresses: JmapEmailAddress[] | undefined): FastmailAddress[] {
  return (addresses ?? []).map(address =>
    address.name ? { email: address.email, name: address.name } : { email: address.email });
}

export function toDraftInfo(record: DraftRecord, content: DraftContent, at: number): FastmailDraftInfo {
  return {
    id: record.id,
    to: toAgentAddresses(content.to),
    cc: toAgentAddresses(content.cc),
    bcc: toAgentAddresses(content.bcc),
    subject: content.subject,
    isReply: record.answersEmailId !== undefined,
    updatedAt: new Date(at),
  };
}

/**
 * Applies one draft revision. Every revision carries the draft's full content (or is a deletion, or
 * a send of an exact snapshot), so one older than the revision already applied has been superseded
 * and is resolved without touching Fastmail. A send creates and submits its approved snapshot as a
 * fresh Email rather than submitting the stored copy, so what leaves the account is exactly what was
 * approved even if the copy in Drafts was edited in Fastmail meanwhile; the stored copy is then
 * discarded.
 *
 * Callers must serialize calls per draft. As with `sendEmail()`, a write whose response is lost
 * after Fastmail accepted it leaves an orphaned copy in Drafts if the approval is retried: JMAP
 * offers no idempotency key.
 */
export async function applyDraftRevision(
  kv: CacheKv, actionId: number, draftId: string, grant: DraftGrant, fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const record = getDraftRecord(kv, draftId);
  const revision = record?.pending[actionId];
  if (!record || !revision) {
    throw new Error(`Unknown pending revision ${actionId} of Fastmail draft ${draftId}.`);
  }
  if (record.applied && record.applied.actionId > actionId) {
    delete record.pending[actionId];
    putDraftRecord(kv, record);
    return;
  }

  const { apiUrl, apiToken, accountId, hasSubmission } = grant;
  const previousEmailId = record.applied?.emailId;
  let emailId: string | undefined;
  if (revision.kind === "content") {
    const draftsMailboxId = await findDraftsMailboxId(apiUrl, apiToken, accountId, hasSubmission, fetchImpl);
    ({ emailId } = await writeDraft(
      apiUrl, apiToken, accountId, hasSubmission, { from: record.from, ...revision.content },
      draftsMailboxId, previousEmailId, fetchImpl));
  } else if (revision.kind === "deleted") {
    if (previousEmailId) {
      await destroyEmails(apiUrl, apiToken, accountId, hasSubmission, [previousEmailId], fetchImpl);
    }
  } else {
    if (!revision.params) throw new Error(`Fastmail draft ${draftId} has no snapshot to send.`);
    const context = await resolveSendContext(apiUrl, apiToken, accountId, revision.params.from, fetchImpl);
    await sendEmail(apiUrl, apiToken, accountId, revision.params, context, fetchImpl);
  }

  // Re-read: revisions may have been submitted while Fastmail was being called.
  const latest = getDraftRecord(kv, draftId) ?? record;
  delete latest.pending[actionId];
  latest.applied = {
    actionId,
    revision: revision.kind === "sent" ? { kind: "sent", at: revision.at } : revision,
    emailId,
  };
  putDraftRecord(kv, latest);

  if (revision.kind === "sent") {
    // Best-effort, as for a reply: the message has already been sent.
    if (previousEmailId) {
      await destroyEmails(apiUrl, apiToken, accountId, hasSubmission, [previousEmailId], fetchImpl)
        .catch(error => logCleanupFailure("draftCleanupFailed", error, actionId));
    }
    if (record.answersEmailId) {
      await updateEmails(
        apiUrl, apiToken, accountId, hasSubmission, [record.answersEmailId],
        { "keywords/$answered": true }, fetchImpl,
      ).catch(error => logCleanupFailure("markAnsweredFailed", error, actionId));
    }
  }
}

/** Rejected: the draft falls back to its newest remaining revision; one with none left never
 * existed in Fastmail, so its record goes too. */
export function rejectDraftRevision(kv: CacheKv, actionId: number, draftId: string): void {
  const record = getDraftRecord(kv, draftId);
  if (!record) return;
  delete record.pending[actionId];
  if (!record.applied && Object.keys(record.pending).length === 0) {
    deleteDraftRecord(kv, draftId);
  } else {
    putDraftRecord(kv, record);
  }
}

function logCleanupFailure(event: string, error: unknown, actionId: number): void {
  // Same shape as `logError()` in ./fastmail.ts.
  console.error(JSON.stringify({
    tag: "fastmail", event: `apply.${event}`, actionId,
    code: error instanceof FastmailError ? error.code : undefined,
    error: error instanceof Error ? error.message : String(error),
  }));
}
