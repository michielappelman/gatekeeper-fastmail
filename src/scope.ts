/**
 * Enforcement of a binding's scope (see `resource.ts`): which emails, folders and listings a
 * whole-mailbox, folder or search binding may reach. Every capability the session hands out (a
 * thread, a message, a hook delivery) carries one `ScopeGuard` and asks it before reading or
 * changing anything, so opening a thread or message id directly can never reach past what the
 * binding's listings would show.
 *
 * Admission is live, as for gatekeeper-google's label and search bindings: an email that leaves the
 * folder, or stops matching the search, drops out of scope. A whole-mailbox guard admits everything
 * without a network round trip, so whole-mailbox bindings behave exactly as before.
 */

import { FastmailError } from "./errors";
import {
  filterEmailsMatching,
  getAdmissionInfo,
  type AdmissionInfo,
  type JmapFilter,
} from "./fastmail-api";
import type { JmapMailboxObject } from "./fastmail-types";
import { MAILBOX_SCOPE, searchFilterCondition, type FastmailScope } from "./resource";

/** The connection details a guard needs to ask Fastmail about admission. */
export type ScopeGrant = {
  apiUrl: string;
  apiToken: string;
  accountId: string;
  hasSubmission: boolean;
};

/** Thrown, as `RESOURCE_NOT_FOUND`, for anything outside the binding: indistinguishable from absent. */
export function outOfScope(what: string): FastmailError {
  return new FastmailError("RESOURCE_NOT_FOUND", `${what} was not found in this Fastmail binding.`);
}

/**
 * System folders a narrowed binding may see and move mail into. Not Sent, Drafts, Scheduled or
 * Snoozed: filing mail there would fake a send, a draft, a scheduled send or a snooze.
 */
const SCOPED_FILING_ROLES: ReadonlySet<string> = new Set(["inbox", "archive", "trash", "junk"]);

export class ScopeGuard {
  constructor(readonly scope: FastmailScope = MAILBOX_SCOPE) {}

  /** Whether this binding is narrower than the whole mailbox. */
  get restricted(): boolean {
    return this.scope.kind !== "mailbox";
  }

  /** The folder every admitted email is in, if the scope implies one. */
  get boundFolderId(): string | undefined {
    if (this.scope.kind === "folder") return this.scope.folderId;
    if (this.scope.kind === "search") return this.scope.filter.folderId;
    return undefined;
  }

  /**
   * The `Email/query` filter for a listing or search the caller asked for, narrowed to the scope.
   * A folder outside a folder binding is refused rather than silently ignored.
   */
  listFilter(caller: { inMailbox?: string; text?: string }): JmapFilter | undefined {
    const callerConditions: JmapFilter[] = [];
    if (caller.inMailbox) callerConditions.push({ inMailbox: caller.inMailbox });
    if (caller.text) callerConditions.push({ text: caller.text });
    switch (this.scope.kind) {
      case "mailbox":
        return callerConditions.length > 0 ? Object.assign({}, ...callerConditions) : undefined;
      case "folder":
        if (caller.inMailbox && caller.inMailbox !== this.scope.folderId) throw outOfScope("That folder");
        return { inMailbox: this.scope.folderId, ...caller.text ? { text: caller.text } : {} };
      case "search":
        return { operator: "AND", conditions: [searchFilterCondition(this.scope.filter), ...callerConditions] };
    }
  }

  /** Of `emailIds`, those the scope admits now, in the given order; ids that don't exist are dropped. */
  async admit(grant: ScopeGrant, emailIds: string[]): Promise<string[]> {
    if (this.scope.kind === "mailbox" || emailIds.length === 0) return emailIds;
    const infos = await getAdmissionInfo(
      grant.apiUrl, grant.apiToken, grant.accountId, grant.hasSubmission, emailIds);
    const admitted = await this.admitInfos(grant, infos);
    return emailIds.filter(id => admitted.has(id));
  }

  /** As `admit()`, for emails whose admission info the caller already fetched. */
  async admitInfos(grant: ScopeGrant, infos: AdmissionInfo[]): Promise<Set<string>> {
    switch (this.scope.kind) {
      case "mailbox":
        return new Set(infos.map(info => info.id));
      case "folder": {
        const folderId = this.scope.folderId;
        return new Set(infos.filter(info => info.mailboxIds?.[folderId]).map(info => info.id));
      }
      case "search": {
        if (infos.length === 0) return new Set();
        return filterEmailsMatching(
          grant.apiUrl, grant.apiToken, grant.accountId, grant.hasSubmission,
          searchFilterCondition(this.scope.filter), infos);
      }
    }
  }

  /**
   * The folders this binding may name: every folder for the whole mailbox; otherwise its own folder
   * and the system folders mail can sensibly be filed into (Inbox, Archive, Trash, Junk), so it can
   * file mail away without learning the rest of the folder tree. A parent outside that set is
   * hidden by clearing `parentId`, so not even its id shows.
   */
  visibleFolders(folders: JmapMailboxObject[]): JmapMailboxObject[] {
    if (this.scope.kind === "mailbox") return folders;
    const bound = this.boundFolderId;
    const visible = folders.filter(folder =>
      folder.id === bound || (folder.role !== null && SCOPED_FILING_ROLES.has(folder.role)));
    const ids = new Set(visible.map(folder => folder.id));
    return visible.map(folder =>
      folder.parentId === null || ids.has(folder.parentId) ? folder : { ...folder, parentId: null });
  }

  /** Refuses sending or drafting new mail on a narrowed binding, which may only answer mail in scope. */
  requireWholeMailbox(what: string): void {
    if (this.restricted) {
      throw new FastmailError(
        "SUBMISSION_NOT_AUTHORIZED",
        `This Fastmail binding is limited to ${this.scope.kind === "folder" ? "one folder" : "a saved search"}, ` +
        `so it can't ${what}. It can reply to messages within that scope.`);
    }
  }
}
