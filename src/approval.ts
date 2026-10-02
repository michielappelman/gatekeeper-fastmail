// What the approver reads before a Fastmail write leaves the workspace: every header and body a
// send carries, and which messages and folder a thread change touches. Values go in `fields`, which
// approval surfaces show literally (see @gadgets/gatekeeper-kit/action-description).

import {
  buildDescription, type RenderedDescription,
} from "@gadgets/gatekeeper-kit/action-description";
import type { SendEmailParams } from "./fastmail-api";
import { textToHtml } from "./fastmail-api";
import type { JmapEmailAddress } from "./fastmail-types";

/** Most messages listed for a thread change; the rest are counted. */
export const MAX_LISTED_MESSAGES = 20;

/** `Name <email>`, or the bare address when there is no name. */
export function formatAddress(address: JmapEmailAddress): string {
  return address.name ? `${address.name} <${address.email}>` : address.email;
}

/**
 * The description of a send or reply: the headers and both bodies exactly as `sendEmail()` will
 * write them. Without an explicit HTML body, the HTML part is the one `sendEmail()` derives from the
 * plain text, shown as it will be sent.
 */
export function describeSend(intro: string, params: SendEmailParams): RenderedDescription {
  const builder = buildDescription(intro).inline("From", params.from);
  if (params.to.length) builder.list("To", params.to.map(formatAddress));
  if (params.cc?.length) builder.list("Cc", params.cc.map(formatAddress));
  if (params.bcc?.length) builder.list("Bcc", params.bcc.map(formatAddress));
  builder.inline("Subject", params.subject);
  if (params.inReplyTo?.length) builder.list("In-Reply-To", params.inReplyTo.map(id => `<${id}>`));
  if (params.references?.length) builder.list("References", params.references.map(id => `<${id}>`));
  if (params.textBody !== undefined) builder.verbatim("Plain text", params.textBody);
  if (params.htmlBody !== undefined) {
    builder.verbatim("HTML", params.htmlBody, "html");
  } else if (params.textBody !== undefined) {
    builder.prose("The HTML version is generated from the plain text.");
    builder.verbatim("HTML", textToHtml(params.textBody), "html");
  }
  return builder.finish();
}

/** One message a thread change applies to, as the approver recognizes it. */
export type MessageSummary = { from: string; subject: string; receivedAt: string };

/**
 * The description of a change to a thread's messages (move, keyword, read state). `messages` is
 * what the gatekeeper could look up about them; when the lookup failed, only the count is known.
 */
export function describeThreadChange(
    intro: string, messageCount: number, messages: MessageSummary[] | undefined,
    extra: { label: string; value: string }[] = []): RenderedDescription {
  const builder = buildDescription(intro);
  for (const { label, value } of extra) builder.inline(label, value);
  if (messages?.length) {
    const listed = messages.slice(0, MAX_LISTED_MESSAGES)
      .map(m => `${m.receivedAt.slice(0, 10)} · ${m.from} · ${m.subject}`);
    builder.list(`Messages (${messageCount})`, listed);
    if (messageCount > listed.length) {
      builder.prose(`And ${messageCount - listed.length} more message(s) in this thread.`);
    }
  } else {
    builder.prose(`Applies to ${messageCount} message(s) in this thread.`);
  }
  return builder.finish();
}
