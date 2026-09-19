/**
 * The one grantable resource this gatekeeper offers in v1 — a connected account's whole Fastmail
 * mailbox — and the parser that recognizes its canonical URL.
 *
 * A resource's `urlPattern` is permanent identity (see gatekeeper-google/src/resources.ts,
 * gatekeeper-jottacloud/src/resource.ts): never change it after deploy. v1 only ever mints the bare
 * `RESOURCE_PATH` form below (no per-folder/per-search scoping yet — see the plan's "Resource /
 * capability model" section); `parseResourceUrl` deliberately rejects any URL carrying a hash, so a
 * later version can start minting `#mailbox/<id>` / `#search/<query>` scoped variants under the same
 * `urlPattern` without colliding with, or needing to migrate, any binding created by this version.
 */

import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import { FastmailError } from "./errors";

/** Host used for this gatekeeper's resource-identity URLs (the real JMAP API host). */
const RESOURCE_HOST = "api.fastmail.com";

/** The only path v1 mints: one whole-mailbox binding per connected account. */
const RESOURCE_PATH = "/jmap/mail/account";

export const FASTMAIL_RESOURCE: SupportedResource = {
  urlPattern: `https://${RESOURCE_HOST}/jmap/mail/*`,
  title: "Fastmail Mailbox",
  description: "Read, search, organize, and send email through one Fastmail account you connect.",
};

export const SUPPORTED_RESOURCES: SupportedResource[] = [FASTMAIL_RESOURCE];

/** Builds the whole-mailbox resource's canonical URL. */
export function toResourceUrl(): string {
  return `https://${RESOURCE_HOST}${RESOURCE_PATH}`;
}

/**
 * Validates that a bound resource URL names the whole-mailbox resource. Throws `INVALID_RESOURCE`
 * on any URL naming a different host or path, or carrying a hash — v1 supports no other resource
 * shape, so there is nothing to parse out of it.
 */
export function parseResourceUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new FastmailError("INVALID_RESOURCE", "Not a valid resource URL.");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== RESOURCE_HOST || parsed.pathname !== RESOURCE_PATH) {
    throw new FastmailError(
      "INVALID_RESOURCE", `Fastmail resource URLs must be https://${RESOURCE_HOST}${RESOURCE_PATH}.`);
  }
  if (parsed.hash) {
    throw new FastmailError(
      "INVALID_RESOURCE",
      "This Fastmail gatekeeper does not yet support per-folder or per-search resource scoping; " +
      "only the whole mailbox can be bound.");
  }
}
