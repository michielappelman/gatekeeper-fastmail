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
import { attachmentSummaries, uploadAttachments } from "./attachments";
import { FastmailError } from "./errors";
import {
  destroyEmails,
  findDraftsMailboxId,
  resolveSendContext,
  sendEmail,
  updateEmails,
  writeDraft,
  type FastmailAccountInfo,
  getDraftEmail,
  type AttachmentRef,
} from "./fastmail-api";
import type { JmapEmailAddress, JmapEmailObject } from "./fastmail-types";
import type { FastmailAddress, FastmailDraftInfo } from "./types";

/** What applying a revision needs from the stored grant. */
export type DraftGrant = Pick<FastmailAccountInfo, "apiUrl" | "accountId" | "hasSubmission"> & {
  apiToken: string;
  /** Needed only to upload a revision's new attachments. */
  uploadUrlTemplate?: string;
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
    isReply: record.answersEmailId !== undefined || (content.inReplyTo?.length ?? 0) > 0,
    isForward: record.forwardsEmailId !== undefined,
    attachments: attachmentSummaries(content.attachments),
    updatedAt: new Date(at),
  };
}

/** The text of the first body part when it is of `type`: JMAP's `textBody` falls back to the HTML part when there is no plain text. */
function bodyOfType(email: JmapEmailObject, parts: JmapEmailObject["textBody"], type: string): string | undefined {
  const part = parts?.[0];
  return part?.partId && part.type === type ? email.bodyValues?.[part.partId]?.value : undefined;
}

/**
 * What an Email in Drafts holds, as the content of a draft revision: addressees, subject, bodies,
 * threading headers, and its attachments as references to their blobs in the Email.
 */
export function draftContentFromEmail(email: JmapEmailObject): DraftContent {
  const content: DraftContent = {
    to: email.to ?? [],
    subject: email.subject ?? "",
  };
  if (email.cc?.length) content.cc = email.cc;
  if (email.bcc?.length) content.bcc = email.bcc;
  const text = bodyOfType(email, email.textBody, "text/plain");
  const html = bodyOfType(email, email.htmlBody, "text/html");
  if (text !== undefined) content.textBody = text;
  if (html !== undefined) content.htmlBody = html;
  if (email.inReplyTo?.length) content.inReplyTo = email.inReplyTo;
  if (email.references?.length) content.references = email.references;
  if (email.attachments?.length) {
    content.attachments = email.attachments.map((attachment): AttachmentRef => ({
      kind: "existing",
      filename: attachment.name ?? "attachment",
      mimeType: attachment.type,
      size: attachment.size,
      blobId: attachment.blobId,
      fromEmailId: email.id,
      source: "this draft in Fastmail",
      ...attachment.cid ? { cid: attachment.cid.replace(/^<|>$/g, "") } : {},
    }));
  }
  return content;
}

/** A draft in Drafts that this connection doesn't hold, as listed: its id is the Email's own. */
export function nativeDraftInfo(email: JmapEmailObject): FastmailDraftInfo {
  return toDraftInfo({ id: email.id, pending: {} }, draftContentFromEmail(email), Date.parse(email.receivedAt));
}

/**
 * A record for the Email `email` in Drafts, as if this connection had written it: its content is
 * the Email's, already applied, so an edit, send or delete goes through the usual revisions and
 * replaces or destroys that Email. The caller stores it.
 */
export function adoptedDraftRecord(email: JmapEmailObject, fallbackFrom: string | undefined): DraftRecord {
  const from = email.from?.[0]?.email ?? fallbackFrom;
  return {
    id: crypto.randomUUID(),
    adopted: true,
    ...from !== undefined ? { from } : {},
    pending: {},
    // Action ids start at 1, so every later revision supersedes this one.
    applied: {
      actionId: 0,
      revision: { kind: "content", content: draftContentFromEmail(email), at: Date.parse(email.receivedAt) },
      emailId: email.id,
    },
  };
}

/**
 * The Email an adopted draft was taken from, while no revision of this connection has been applied
 * (so it is still the one Fastmail's own editor holds). Undefined for any other record.
 */
export function adoptedSourceEmailId(record: DraftRecord): string | undefined {
  return record.adopted && record.applied?.actionId === 0 ? record.applied.emailId : undefined;
}

/** Whether `emailId` is still an Email in the Drafts mailbox. */
export async function emailInDrafts(
  grant: DraftGrant, emailId: string, fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const { apiUrl, apiToken, accountId, hasSubmission } = grant;
  const draftsMailboxId = await findDraftsMailboxId(apiUrl, apiToken, accountId, hasSubmission, fetchImpl);
  const email = await getDraftEmail(apiUrl, apiToken, accountId, hasSubmission, emailId, fetchImpl);
  return email?.mailboxIds[draftsMailboxId] === true;
}

/**
 * Refuses a change to an adopted draft whose source Email has gone from Drafts (edited or discarded
 * in Fastmail since it was opened): the record's content is stale and applying would overwrite or
 * duplicate what is there now. Anything else passes.
 */
export async function assertAdoptedSourceLive(
  grant: DraftGrant, record: DraftRecord, fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const sourceId = adoptedSourceEmailId(record);
  if (sourceId !== undefined && !await emailInDrafts(grant, sourceId, fetchImpl)) {
    throw new FastmailError(
      "RESOURCE_NOT_FOUND",
      "This Fastmail draft was changed or discarded in Fastmail since it was opened; list the drafts again.");
  }
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
  await assertAdoptedSourceLive(grant, record, fetchImpl);

  const { apiUrl, apiToken, accountId, hasSubmission } = grant;
  const previousEmailId = record.applied?.emailId;
  let emailId: string | undefined;
  if (revision.kind === "content") {
    const draftsMailboxId = await findDraftsMailboxId(apiUrl, apiToken, accountId, hasSubmission, fetchImpl);
    const attachmentBlobs = await uploadAttachments(
      kv, { ...grant, uploadUrlTemplate: grant.uploadUrlTemplate ?? "" }, revision.content.attachments, fetchImpl);
    ({ emailId } = await writeDraft(
      apiUrl, apiToken, accountId, hasSubmission, { from: record.from, ...revision.content, attachmentBlobs },
      draftsMailboxId, previousEmailId, fetchImpl));
  } else if (revision.kind === "deleted") {
    if (previousEmailId) {
      await destroyEmails(apiUrl, apiToken, accountId, hasSubmission, [previousEmailId], fetchImpl);
    }
  } else {
    if (!revision.params) throw new Error(`Fastmail draft ${draftId} has no snapshot to send.`);
    const context = await resolveSendContext(apiUrl, apiToken, accountId, revision.params.from, fetchImpl);
    const attachmentBlobs = await uploadAttachments(
      kv, { ...grant, uploadUrlTemplate: grant.uploadUrlTemplate ?? "" }, revision.params.attachments, fetchImpl);
    await sendEmail(apiUrl, apiToken, accountId, { ...revision.params, attachmentBlobs }, context, fetchImpl);
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
    if (record.forwardsEmailId) {
      await updateEmails(
        apiUrl, apiToken, accountId, hasSubmission, [record.forwardsEmailId],
        { "keywords/$forwarded": true }, fetchImpl,
      ).catch(error => logCleanupFailure("markForwardedFailed", error, actionId));
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
