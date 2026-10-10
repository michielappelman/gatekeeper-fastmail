/**
 * Attachments on drafts and sends. Nothing reaches Fastmail before approval: new content is checked,
 * hashed and kept in the binding's own Durable Object storage until the draft or send that names it
 * is applied, and only then uploaded (`uploadAttachments()`). Content is stored once per SHA-256, in
 * chunks, and revisions only reference it, so editing a draft doesn't copy its attachments; content
 * no pending action or draft references any more is deleted (`collectAttachmentGarbage()`).
 *
 * An attachment already in the account (one of a message's attachments) needs no upload: JMAP can
 * reference its blob directly. It is admitted only from a message the binding's scope admits.
 */

import { listDraftRecords, type CacheKv, type DraftRevision, type PendingAction } from "./cache";
import { FastmailError } from "./errors";
import { getMessages, uploadBlob, type AttachmentRef, type UploadedBlob } from "./fastmail-api";
import type { ScopeGrant, ScopeGuard } from "./scope";
import { outOfScope } from "./scope";
import type { FastmailOutgoingAttachment } from "./types";

/** At most this many attachments per message. */
export const MAX_ATTACHMENTS = 20;
/** At most this many attachment bytes per message, new and existing together. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Stored content is split into values of at most this size. */
const CHUNK_BYTES = 512 * 1024;
const MAX_FILENAME = 255;
const MIME_TYPE = /^[A-Za-z0-9][\w.+-]*\/[A-Za-z0-9][\w.+-]*$/;
const JMAP_ID = /^[A-Za-z0-9_-]{1,255}$/;

const metaKey = (sha256: string) => `attmeta:${sha256}`;
const chunkKey = (sha256: string, index: number) => `attchunk:${sha256}:${index}`;
type StoredMeta = { size: number; chunks: number };

/** What preparing attachments needs: storage for new content, and the scope for existing ones. */
export type AttachmentContext = {
  kv: CacheKv;
  grant: ScopeGrant;
  guard: ScopeGuard;
};

/**
 * Validates the attachments a caller passed and returns what a draft or send records: references to
 * content now stored in `kv`, or to attachments of messages in scope. Every check runs before any
 * content is stored, so a refused list stores nothing.
 */
export async function prepareAttachments(
  input: FastmailOutgoingAttachment[] | undefined, ctx: AttachmentContext,
): Promise<AttachmentRef[] | undefined> {
  if (input === undefined || input.length === 0) return undefined;
  if (!Array.isArray(input)) throw invalid("attachments must be an array.");
  if (input.length > MAX_ATTACHMENTS) throw invalid(`At most ${MAX_ATTACHMENTS} attachments are allowed.`);

  const prepared: (AttachmentRef & { content?: Uint8Array })[] = [];
  const existing = new Map<string, string[]>();
  for (const attachment of input) {
    if ("content" in attachment) {
      if (!(attachment.content instanceof ArrayBuffer)) throw invalid("Attachment content must be an ArrayBuffer.");
      const filename = cleanFilename(attachment.filename);
      if (typeof attachment.mimeType !== "string" || !MIME_TYPE.test(attachment.mimeType)) {
        throw invalid(`Attachment ${filename}: mimeType must look like "application/pdf".`);
      }
      const content = new Uint8Array(attachment.content.slice(0));
      prepared.push({
        kind: "new", filename, mimeType: attachment.mimeType.toLowerCase(), size: content.byteLength,
        sha256: await sha256Hex(content), content,
      });
    } else {
      const { fromMessageId, blobId } = attachment;
      if (typeof fromMessageId !== "string" || !JMAP_ID.test(fromMessageId) ||
          typeof blobId !== "string" || !JMAP_ID.test(blobId)) {
        throw invalid("An existing attachment needs a message id and the blobId of one of its attachments.");
      }
      existing.set(fromMessageId, [...existing.get(fromMessageId) ?? [], blobId]);
      prepared.push({
        kind: "existing", filename: attachment.filename === undefined ? "" : cleanFilename(attachment.filename),
        mimeType: "", size: 0, blobId, fromEmailId: fromMessageId, source: "",
      });
    }
  }

  if (existing.size > 0) {
    const ids = [...existing.keys()];
    const admitted = new Set(await ctx.guard.admit(ctx.grant, ids));
    const emails = await getMessages(
      ctx.grant.apiUrl, ctx.grant.apiToken, ctx.grant.accountId, ctx.grant.hasSubmission, [...admitted]);
    for (const ref of prepared) {
      if (ref.kind !== "existing") continue;
      const email = admitted.has(ref.fromEmailId) ? emails.find(candidate => candidate.id === ref.fromEmailId) : undefined;
      if (!email) throw outOfScope("That message");
      const source = (email.attachments ?? []).find(candidate => candidate.blobId === ref.blobId);
      if (!source) throw new FastmailError("RESOURCE_NOT_FOUND", "That attachment does not belong to that message.");
      ref.filename ||= cleanFilename(source.name ?? "attachment");
      ref.mimeType = source.type;
      ref.size = source.size;
      const sender = email.from?.[0];
      ref.source = `${email.receivedAt.slice(0, 10)} · ${sender ? sender.name || sender.email : "(no sender)"} · ` +
        `${email.subject || "(no subject)"}`;
    }
  }

  const total = prepared.reduce((sum, ref) => sum + ref.size, 0);
  if (total > MAX_ATTACHMENT_BYTES) {
    throw invalid(`Attachments may total at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MiB per message.`);
  }

  for (const ref of prepared) {
    if (ref.kind === "new" && ref.content) storeContent(ctx.kv, ref.sha256, ref.content);
  }
  return prepared.map(({ content: _content, ...ref }) => ref);
}

/** The attachment list of a draft's info, for the agent. */
export function attachmentSummaries(refs: AttachmentRef[] | undefined) {
  return (refs ?? []).map(ref => ({ filename: ref.filename, mimeType: ref.mimeType, size: ref.size }));
}

/** Uploads stored content and returns every attachment as a blob to put on the Email. */
export async function uploadAttachments(
  kv: CacheKv,
  grant: { apiToken: string; accountId: string; uploadUrlTemplate: string },
  refs: AttachmentRef[] | undefined, fetchImpl: typeof fetch = fetch,
): Promise<UploadedBlob[] | undefined> {
  if (!refs?.length) return undefined;
  const blobs: UploadedBlob[] = [];
  for (const ref of refs) {
    if (ref.kind === "existing") {
      blobs.push({ blobId: ref.blobId, type: ref.mimeType, name: ref.filename, ...ref.cid ? { cid: ref.cid } : {} });
      continue;
    }
    const content = loadContent(kv, ref.sha256);
    if (!content) {
      throw new FastmailError("RESOURCE_NOT_FOUND", `The content of attachment ${ref.filename} is no longer stored.`);
    }
    const uploaded = await uploadBlob(
      grant.uploadUrlTemplate, grant.apiToken, grant.accountId, content, ref.mimeType, fetchImpl);
    if (uploaded.size !== ref.size) {
      throw new FastmailError("UPSTREAM_UNAVAILABLE", `Fastmail stored attachment ${ref.filename} with the wrong size.`);
    }
    blobs.push({ blobId: uploaded.blobId, type: ref.mimeType, name: ref.filename });
  }
  return blobs;
}

/**
 * Deletes stored content no pending action or draft references. `kv` must be able to list keys (a
 * Durable Object's). Best-effort: a failure leaves content for the next collection.
 */
export function collectAttachmentGarbage(kv: CacheKv & {
  list<T>(options: { prefix: string }): Iterable<[string, T]>;
}): void {
  const referenced = new Set<string>();
  const note = (refs: AttachmentRef[] | undefined) => {
    for (const ref of refs ?? []) if (ref.kind === "new") referenced.add(ref.sha256);
  };
  const noteRevision = (revision: DraftRevision | undefined) => {
    if (revision?.kind === "content") note(revision.content.attachments);
    else if (revision?.kind === "sent") note(revision.params?.attachments);
  };
  for (const [, pending] of kv.list<PendingAction>({ prefix: "action:pending:" })) {
    if (pending.kind === "send") note(pending.params.attachments);
  }
  for (const record of listDraftRecords(kv)) {
    noteRevision(record.applied?.revision);
    for (const revision of Object.values(record.pending)) noteRevision(revision);
  }
  // A snapshot, since entries are deleted while going through it.
  for (const [key, meta] of Array.from(kv.list<StoredMeta>({ prefix: "attmeta:" }))) {
    const sha256 = key.slice("attmeta:".length);
    if (referenced.has(sha256)) continue;
    for (let index = 0; index < meta.chunks; index++) kv.delete(chunkKey(sha256, index));
    kv.delete(key);
  }
}

function storeContent(kv: CacheKv, sha256: string, content: Uint8Array): void {
  if (kv.get<StoredMeta>(metaKey(sha256))) return;
  const chunks = Math.max(1, Math.ceil(content.byteLength / CHUNK_BYTES));
  for (let index = 0; index < chunks; index++) {
    kv.put(chunkKey(sha256, index), content.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).buffer);
  }
  // Written last, so content is only ever found whole.
  kv.put<StoredMeta>(metaKey(sha256), { size: content.byteLength, chunks });
}

function loadContent(kv: CacheKv, sha256: string): Uint8Array | undefined {
  const meta = kv.get<StoredMeta>(metaKey(sha256));
  if (!meta) return undefined;
  const content = new Uint8Array(meta.size);
  let offset = 0;
  for (let index = 0; index < meta.chunks; index++) {
    const chunk = kv.get<ArrayBuffer>(chunkKey(sha256, index));
    if (!chunk) return undefined;
    content.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }
  return offset === meta.size ? content : undefined;
}

/** A filename kept to one line, without path separators or control characters. */
function cleanFilename(filename: unknown): string {
  if (typeof filename !== "string") throw invalid("Every attachment needs a filename.");
  // eslint-disable-next-line no-control-regex
  const clean = filename.replace(/[\u0000-\u001f\u007f/\\]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) throw invalid("Every attachment needs a filename.");
  if (clean.length > MAX_FILENAME) throw invalid("An attachment filename is too long.");
  return clean;
}

async function sha256Hex(content: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", content));
  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function invalid(message: string): FastmailError {
  return new FastmailError("INVALID_RESOURCE", message);
}
