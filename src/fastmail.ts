import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint, restore } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  stripTrailingSlashes,
  type AccountDescription,
  type ActionKind,
  type ApprovalQueue,
  type ConnectHandoff,
  type Cursor,
  type Gatekeeper,
  type GatekeeperConnectCallback,
  type GatekeeperUser,
  type GatekeeperUserVerifier,
  type GatekeeperVendor as GatekeeperVendorIface,
  type ResourceConfiguratorFrame,
  type ResourceDescription,
  type SupportedResource,
  type VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  connectHandoffPageHtml,
  errorPageHtml,
  escapeHtml,
  htmlResponse,
} from "@gadgets/gatekeeper-kit/connect-pages";
import { commitStagedCredentials, stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import {
  constantTimeEqual,
  CONNECT_TIMEOUT_MS,
  generateNonce,
  INITIATION_NONCE_LIFETIME_MS,
  isLiveNonce,
  NONCE_BYTES,
  type TimedNonce,
} from "@gadgets/gatekeeper-kit/connect-nonce";
import { OffsetCursor } from "@gadgets/gatekeeper-kit/cursors";
import { describeSend, describeThreadChange, formatAddress, type MessageSummary } from "./approval";
import type { RenderedDescription } from "@gadgets/gatekeeper-kit/action-description";
import {
  clearSimulatedKeywordsIfLatest,
  currentDraftRevision,
  deletePendingAction,
  listDraftRecords,
  putDraftRecord,
  type DraftContent,
  type DraftRecord,
  type DraftRevision,
  getCachedAttachmentMarkdown,
  getCachedFolders,
  getPendingAction,
  getSimulatedKeywords,
  mergeSimulatedKeywords,
  putCachedAttachmentMarkdown,
  putCachedFolders,
  setPendingAction,
  setSimulatedKeywords,
} from "./cache";
import { applyDraftRevision, currentDraft, rejectDraftRevision, toDraftInfo } from "./drafts";
import { FastmailError } from "./errors";
import { assertMarkdownConvertible, convertToMarkdown } from "./markdown";
import {
  downloadBlob,
  fetchAccountInfo,
  getAdmissionInfo,
  getEmailHeaders,
  queryMessagePage,
  fetchIdentityEmail,
  getMessages,
  getReplySource,
  getThreadMetadata,
  replyRecipients,
  listMailboxes,
  queryThreadPage,
  resolveSendContext,
  sendEmail,
  updateEmails,
  type FastmailAccountInfo,
  type JmapReplySource,
  type RawThreadEntry,
  type SendEmailParams,
} from "./fastmail-api";
import type { JmapAttachment, JmapEmailObject, JmapMailboxObject } from "./fastmail-types";
import {
  handlePush,
  type FastmailHookDelivery,
  type FastmailHookParams,
  type FastmailMessageHookTarget,
} from "./hooks";
import {
  describeSearchFilter,
  FASTMAIL_RESOURCE,
  MAILBOX_SCOPE,
  normalizeSearchFilter,
  parseResourceUrl,
  SUPPORTED_RESOURCES,
  toResourceUrl,
  type FastmailScope,
} from "./resource";
import { outOfScope, ScopeGuard } from "./scope";
import type {
  FastmailAddress,
  FastmailAttachment,
  FastmailDraftInfo,
  FastmailDraftInput,
  FastmailDraftPatch,
  FastmailFolder,
  FastmailMarkdownContent,
  FastmailMessage,
  FastmailMessageEntry,
  FastmailMessageRef,
  FastmailSendableDraft,
  FastmailSession,
  FastmailThread,
  FastmailThreadEntry,
} from "./types";
import TYPES_CODE from "./types.txt";
import type {
  ConfiguratorOption,
  FastmailAccountConfiguratorRpc,
  FastmailAccountConfiguratorValues,
} from "./configurator/fastmail-account-configurator-types";
import FASTMAIL_ACCOUNT_CONFIGURATOR_HTML from "./generated/fastmail-account-configurator-ui.txt";

type Env = Cloudflare.Env & {
  BASE_URL?: string;
};

function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL ?? "http://localhost:8787/gatekeeper/fastmail");
}

function getBasePath(env: Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

// Fastmail brand mark (simplified envelope glyph), inlined so the gatekeeper needs no hosted asset.
const FASTMAIL_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">\
<path d="M3 5h18v14H3z" fill="none" stroke="#0067b9" stroke-width="1.5"/>\
<path d="M3.5 5.5 12 13l8.5-7.5" fill="none" stroke="#0067b9" stroke-width="1.5"/>\
</svg>`;
const FASTMAIL_LOGO_URL = `data:image/svg+xml;utf8,${encodeURIComponent(FASTMAIL_LOGO_SVG)}`;

function errorMessage(error: unknown): string {
  if (error instanceof FastmailError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/** User-controlled text (a folder name, a search term) kept to one line and out of the Markdown. */
function plainInline(text: string): string {
  return text.replace(/[\r\n"`*_[\]<>]/g, " ").trim();
}

/** One structured line per failure, greppable in `wrangler tail` output by `"tag":"fastmail"`. */
function logError(event: string, error: unknown, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({
    tag: "fastmail", event, ...fields,
    code: error instanceof FastmailError ? error.code : undefined,
    error: errorMessage(error),
  }));
}

// ---------------------------------------------------------------------------
// HTML for the connect flow. Fastmail's JMAP API accepts only a bearer API token (not the app
// passwords issued for IMAP/SMTP), so the human generates one from Fastmail's own settings and
// pastes it here — the same "paste a credential, then ping to verify" shape as
// gatekeeper-homeassistant's long-lived-token flow, since there is no OAuth redirect to use instead.

const CONNECT_FORM_HTML = (params: { actionUrl: string; error?: string }) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Connect Fastmail</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #f5f5f5; margin: 0; min-height: 100vh; display: flex; justify-content: center; align-items: center; }
  .card { background: white; padding: 2rem; max-width: 540px; width: 100%; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
  h1 { margin-top: 0; font-size: 1.4rem; color: #0067b9; }
  label { display: block; font-weight: 600; margin-top: 1rem; margin-bottom: 0.25rem; color: #333; }
  input { width: 100%; box-sizing: border-box; padding: 0.5rem; font-size: 0.9rem; border: 1px solid #ccc; border-radius: 4px; font-family: ui-monospace, monospace; }
  details { margin-top: 1rem; font-size: 0.9rem; color: #555; }
  summary { cursor: pointer; color: #0067b9; }
  details ol { padding-left: 1.25rem; }
  button { margin-top: 1.5rem; padding: 0.6rem 1.5rem; background: #0067b9; color: white; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer; }
  button:hover { background: #005494; }
  .error { background: #ffebee; color: #c62828; padding: 0.75rem 1rem; border-radius: 4px; margin: 1rem 0; }
</style>
</head>
<body>
  <div class="card">
    <h1>Connect Fastmail</h1>
    <p>Paste a Fastmail API token. Cloudflare OS uses it directly to read, organize, and send email through your mailbox — it never sees your Fastmail password.</p>
    ${params.error ? `<div class="error">${escapeHtml(params.error)}</div>` : ""}
    <form method="POST" action="${escapeHtml(params.actionUrl)}">
      <label for="apiToken">Fastmail API token</label>
      <input id="apiToken" name="apiToken" type="text" required placeholder="fmu1-..." autofocus>

      <details open>
        <summary>How to create an API token</summary>
        <ol>
          <li>Open <a href="https://app.fastmail.com/settings/security/tokens" target="_blank" rel="noopener">Settings &rarr; Password &amp; Security &rarr; API tokens</a>.</li>
          <li>Create a new token and grant it "Mail" access (add "Email submission" too if you want this connection to be able to send mail on your behalf).</li>
          <li>Copy the token and paste it above.</li>
        </ol>
      </details>

      <button type="submit">Connect</button>
    </form>
  </div>
</body>
</html>`;

// ---------------------------------------------------------------------------
// fetch handler: serves the connect form and accepts its POST

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const basePath = getBasePath(env);
    if (!url.pathname.startsWith(`${basePath}/`) && url.pathname !== basePath) {
      throw new Error(`Request path ${url.pathname} does not match BASE_URL path ${basePath}`);
    }
    const relPath = url.pathname.slice(basePath.length);
    const path = relPath.slice(1).split("/");

    // Connect URL: /<doId>/<nonce>
    if (path.length === 2 && path[0].length === 64 && path[1].length === NONCE_BYTES * 2) {
      const doId = path[0];
      const nonce = path[1];
      const stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));

      if (req.method === "GET") {
        const valid = await stub.verifyNonceWithoutConsuming(nonce);
        if (!valid) return htmlResponse(errorPageHtml("Link expired", "Start the connection again."));
        return htmlResponse(CONNECT_FORM_HTML({ actionUrl: req.url }));
      }

      if (req.method === "POST") {
        let formData: FormData;
        try {
          formData = await req.formData();
        } catch {
          return new Response("Invalid form submission.", { status: 400 });
        }
        const apiToken = String(formData.get("apiToken") ?? "").trim();
        if (!apiToken) {
          return htmlResponse(
            CONNECT_FORM_HTML({ actionUrl: req.url, error: "A Fastmail API token is required." }), 400);
        }

        const result = await stub.completeConnection(nonce, apiToken);
        if (result.kind === "invalid_nonce") {
          return htmlResponse(errorPageHtml("Link expired", "Start the connection again."));
        }
        if (result.kind === "error") {
          return htmlResponse(CONNECT_FORM_HTML({ actionUrl: req.url, error: result.message }), 400);
        }
        return htmlResponse(connectHandoffPageHtml(result.handoff));
      }
    }

    // Fastmail's JMAP pushes for new-mail hooks: /push/<driver>/<secret> (see hooks.ts).
    const push = await handlePush(relPath, req, ctx.exports);
    if (push) return push;

    return new Response("Not Found", { status: 404 });
  },
};

// ---------------------------------------------------------------------------
// Vendor

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Fastmail",
      url: "https://www.fastmail.com",
      logo: { url: FASTMAIL_LOGO_URL },
      color: "#e6f2fa",
      tagline: "Read, organize, and send email through your Fastmail mailbox",
      description:
          "Connect a Fastmail API token so Cloudflare OS can read, search, organize, and send " +
          "email through your Fastmail account over JMAP. The token grants exactly the access you " +
          "chose when creating it in Fastmail's own settings.",
      providesAuth: false,
    };
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>): Promise<{ url: string }> {
    const userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    const nonce = generateNonce();
    await this.ctx.exports.UserAccount.get(userObjectId).setCallback(callback, nonce);
    return { url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${nonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

// ---------------------------------------------------------------------------
// UserAccount DO — stores the Fastmail API token and the account info resolved from it at connect
// time. Unlike an OAuth grant there is no refresh cycle: the token is live until Fastmail revokes it.

type StoredGrant = {
  apiToken: string;
} & FastmailAccountInfo;

type StoredNonce = TimedNonce & {
  reconnect?: true;
  /** Set while a submission is being validated against Fastmail, so a concurrent submission cannot
   * pass the same nonce; cleared again when validation fails so the user can resubmit. */
  connecting?: true;
};

type CompleteConnectionResult =
  | { kind: "ok"; handoff: ConnectHandoff }
  | { kind: "invalid_nonce" }
  | { kind: "error"; message: string };

export class UserAccount extends DurableObject<Env> {
  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, nonce: string): Promise<void> {
    if (!this.ctx.storage.kv.get<StoredGrant>("grant")) {
      await this.ctx.storage.setAlarm(Date.now() + CONNECT_TIMEOUT_MS);
    }
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: nonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
    });
  }

  async prepareReconnect(nonce: string): Promise<void> {
    this.ctx.storage.kv.put("expiredNotified", false);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: nonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      reconnect: true,
    });
  }

  /** Validates the nonce without consuming it, for the GET preview of the form. */
  async verifyNonceWithoutConsuming(nonce: string): Promise<boolean> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    return !stored?.connecting && isLiveNonce(stored, nonce, Date.now());
  }

  #releaseNonceClaim(nonce: string): void {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (stored && constantTimeEqual(stored.value, nonce)) {
      this.ctx.storage.kv.put<StoredNonce>("nonce", { ...stored, connecting: undefined });
    }
  }

  async completeConnection(nonce: string, apiToken: string): Promise<CompleteConnectionResult> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.connecting || !isLiveNonce(stored, nonce, Date.now())) {
      return { kind: "invalid_nonce" };
    }
    // Claim the nonce before the first await: the input gate does not cover the outbound exchange,
    // so a second submission arriving meanwhile would otherwise validate the same nonce twice.
    this.ctx.storage.kv.put<StoredNonce>("nonce", { ...stored, connecting: true });

    let grant: StoredGrant;
    try {
      const info = await fetchAccountInfo(apiToken);
      let identityEmail: string | undefined;
      try {
        identityEmail = await fetchIdentityEmail(info.apiUrl, apiToken, info.accountId);
      } catch {
        // Identity/get failing is not fatal to connecting: send() will simply report it has no
        // "From" address to use until the account is reconnected with a token that can read it.
      }
      grant = { apiToken, ...info, identityEmail };
    } catch (error) {
      this.#releaseNonceClaim(nonce);
      return { kind: "error", message: errorMessage(error) };
    }

    this.ctx.storage.kv.delete("nonce");
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) {
      return { kind: "error", message: "Took too long to complete authorization. Please try again." };
    }

    let handoff: ConnectHandoff;
    if (stored.reconnect) {
      // The reconnect URL is a bearer capability, so the new grant is only staged until the
      // Workshop confirms the browser that finished the flow is the owner's.
      const stageId = stageCredentials(this.ctx.storage.kv, grant, Date.now());
      handoff = await callback.reconnectComplete(stageId);
    } else {
      this.#writeGrant(grant);
      try {
        const props: FastmailGatekeeperUserImplProps = { userObjectId: this.ctx.id.toString() };
        handoff = await callback.complete(this.ctx.exports.FastmailGatekeeperUserImpl({ props }));
      } catch (err) {
        this.ctx.storage.kv.delete("grant");
        throw err;
      }
    }
    await this.ctx.storage.deleteAlarm();
    return { kind: "ok", handoff };
  }

  /** Makes the grant staged under `stageId` by a reconnect flow live. */
  async commitReconnect(stageId: string): Promise<void> {
    const grant = commitStagedCredentials<StoredGrant>(this.ctx.storage.kv, Date.now(), stageId);
    if (!grant) throw new Error("No reconnect is awaiting confirmation. Please try again.");
    this.#writeGrant(grant);
  }

  #writeGrant(grant: StoredGrant): void {
    this.ctx.storage.kv.put("grant", grant);
    this.ctx.storage.kv.put("expiredNotified", false);
  }

  /** The connected address, and whether the token can send mail (see `requireSender()`). */
  async getIdentity(): Promise<{ email?: string; canSend: boolean } | undefined> {
    const grant = this.ctx.storage.kv.get<StoredGrant>("grant");
    return grant
      ? { email: grant.identityEmail ?? grant.username, canSend: canSend(grant) }
      : undefined;
  }

  async getGrant(): Promise<StoredGrant> {
    const grant = this.ctx.storage.kv.get<StoredGrant>("grant");
    if (!grant) throw new FastmailError("AUTH_REQUIRED", "Fastmail is not connected.");
    return grant;
  }

  /** Called by a session when a live JMAP call comes back 401, since there is no refresh to retry
   * first — a rejected token here means it was revoked or deleted in Fastmail's own settings. */
  async noteCredentialsExpired(): Promise<void> {
    if (this.ctx.storage.kv.get<boolean>("expiredNotified")) return;
    this.ctx.storage.kv.put("expiredNotified", true);
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (callback) await callback.credentialsExpired();
  }

  async alarm(): Promise<void> {
    if (!this.ctx.storage.kv.get<StoredGrant>("grant")) {
      await this.ctx.storage.deleteAll();
    }
  }

  async revoke(): Promise<void> {
    // Fastmail exposes no token-revocation endpoint this gatekeeper calls; dropping the local
    // credentials still prevents any further use from this Gatekeeper. The user can additionally
    // delete the token itself from Fastmail's API token settings.
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

// ---------------------------------------------------------------------------
// GatekeeperUserImpl — maps the one bound resource URL to a FastmailGatekeeperImpl DO

type FastmailGatekeeperUserImplProps = {
  userObjectId: string;
};

@validateRpc()
export class FastmailGatekeeperUserImpl extends WorkerEntrypoint<Env, FastmailGatekeeperUserImplProps>
    implements GatekeeperUser {
  #userAccount(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  async describe(): Promise<AccountDescription> {
    const identity = await this.#userAccount().getIdentity();
    return {
      displayName: identity?.email ?? "Fastmail Account",
      uniqueName: identity?.email,
      avatar: { url: FASTMAIL_LOGO_URL },
    };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    const scope = parseResourceUrl(url);
    const props: FastmailGatekeeperImplProps = { userObjectId: this.ctx.props.userObjectId, scope };
    return { class: this.ctx.exports.FastmailGatekeeperImpl({ props }), resource: FASTMAIL_RESOURCE };
  }

  /**
   * v1 offers exactly one resource shape (the whole mailbox) with no user-selectable inputs, but the
   * connect modal still unconditionally drives every SupportedResource through this method before
   * "Add connection" can be enabled — there is no way to opt out of it. So this returns a trivial
   * configurator (no fields, always ready) rather than throwing, matching gatekeeper-zoominfo's
   * whole-account resource.
   */
  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern !== FASTMAIL_RESOURCE.urlPattern) {
      throw new Error(`Unsupported Fastmail resource configurator type: ${resourceUrlPattern}`);
    }
    return {
      iframeHtml: FASTMAIL_ACCOUNT_CONFIGURATOR_HTML,
      ui: new RpcStub(new FastmailAccountConfiguratorUI(this.#userAccount())),
    };
  }

  async revoke(): Promise<void> {
    await this.#userAccount().revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    const nonce = generateNonce();
    await this.#userAccount().prepareReconnect(nonce);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${nonce}` };
  }

  async commitReconnect(stageId: string): Promise<void> {
    await this.#userAccount().commitReconnect(stageId);
  }

  /** Fastmail is not offered as a sign-in identity provider (see VendorDescription.providesAuth). */
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  /** The API token already grants whatever scope it was created with; there is no narrower
   * per-resource-type grant to request, so there is nothing to expand here. */
  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  /** Strategy A (private-only, see FastmailGatekeeperImpl.addObserver): the verifier is never
   * consulted, but the overseer mints one on every collaborator open, so this must still resolve. */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.FastmailVerifier({});
  }
}

@validateRpc()
export class FastmailVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

// ---------------------------------------------------------------------------
// Resource configurator — whole-mailbox has no inputs; just reports the canonical URL.

@validateRpc()
export class FastmailAccountConfiguratorUI extends RpcTarget implements FastmailAccountConfiguratorRpc {
  constructor(private readonly account?: DurableObjectStub<UserAccount>) {
    super();
  }

  async resourceUrl(values?: FastmailAccountConfiguratorValues): Promise<string> {
    return toResourceUrl(scopeFromConfiguratorValues(values ?? {}));
  }

  async listFolders(query: string): Promise<ConfiguratorOption[]> {
    if (!this.account) return [];
    const grant = await this.account.getGrant();
    const folders = await listMailboxes(grant.apiUrl, grant.apiToken, grant.accountId, grant.hasSubmission);
    const byId = new Map(folders.map(folder => [folder.id, folder]));
    const path = (folder: JmapMailboxObject): string => {
      const names = [folder.name];
      for (let parent = folder.parentId && byId.get(folder.parentId), depth = 0; parent && depth < 20;
           parent = parent.parentId ? byId.get(parent.parentId) : undefined, depth++) {
        names.unshift(parent.name);
      }
      return names.join(" / ");
    };
    const needle = query.trim().toLowerCase();
    return folders
      .map(folder => ({ folder, path: path(folder) }))
      .filter(({ path }) => !needle || path.toLowerCase().includes(needle))
      .toSorted((a, b) => a.path.localeCompare(b.path))
      .slice(0, 50)
      .map(({ folder, path }) => ({
        value: folder.id,
        title: path,
        subtitle: folder.role ? `System folder (${folder.role})` : undefined,
        meta: `${folder.totalEmails} message(s)`,
      }));
  }

  async valuesFromResourceUrl(resourceUrl: string): Promise<FastmailAccountConfiguratorValues> {
    const scope = parseResourceUrl(resourceUrl);
    if (scope.kind === "folder") return { mode: "folder", folderId: scope.folderId };
    if (scope.kind === "search") {
      const { from, to, subject, text, folderId } = scope.filter;
      return {
        mode: "search", from: from ?? null, to: to ?? null, subject: subject ?? null, text: text ?? null,
        searchFolderId: folderId ?? null,
      };
    }
    return { mode: "all" };
  }
}

/** The scope the configurator's values choose; throws `INVALID_RESOURCE` for an incomplete form. */
export function scopeFromConfiguratorValues(values: FastmailAccountConfiguratorValues): FastmailScope {
  const mode = values.mode ?? "all";
  if (mode === "folder") {
    if (!values.folderId) throw new FastmailError("INVALID_RESOURCE", "Choose a folder.");
    return { kind: "folder", folderId: values.folderId };
  }
  if (mode === "search") {
    return {
      kind: "search",
      filter: normalizeSearchFilter({
        from: values.from ?? undefined,
        to: values.to ?? undefined,
        subject: values.subject ?? undefined,
        text: values.text ?? undefined,
        folderId: values.searchFolderId ?? undefined,
      }),
    };
  }
  return MAILBOX_SCOPE;
}

// ---------------------------------------------------------------------------
// GatekeeperImpl DO — the connected account's whole mailbox, bound to one Gadget.

type FastmailGatekeeperImplProps = {
  userObjectId: string;
  /** What this binding may see; absent on facets bound before scopes existed, which are whole-mailbox. */
  scope?: FastmailScope;
};

function toAgentFolder(mailbox: JmapMailboxObject): FastmailFolder {
  const role = mailbox.role as FastmailFolder["role"];
  return {
    id: mailbox.id,
    name: mailbox.name,
    role: role ?? null,
    parentId: mailbox.parentId,
    totalEmails: mailbox.totalEmails,
    unreadEmails: mailbox.unreadEmails,
  };
}

function formatAddresses(addresses: JmapEmailObject["from"] | null | undefined): string {
  return (addresses ?? []).map(address => address.name ? `${address.name} <${address.email}>` : address.email)
    .join(", ");
}

function toThreadEntry(raw: RawThreadEntry, keywordOverlay: Record<string, boolean> | undefined): FastmailThreadEntry {
  const keywords = mergeSimulatedKeywords(raw.keywords, keywordOverlay);
  return {
    threadId: raw.threadId,
    subject: raw.subject ?? "(no subject)",
    from: formatAddresses(raw.from),
    lastMessageAt: new Date(raw.receivedAt),
    unread: !keywords["$seen"],
    snippet: raw.preview,
  };
}

function toMessageEntry(
  raw: RawThreadEntry, keywordOverlay: Record<string, boolean> | undefined, ref: FastmailMessageRef,
): FastmailMessageEntry {
  const keywords = mergeSimulatedKeywords(raw.keywords, keywordOverlay);
  return {
    id: raw.id,
    threadId: raw.threadId,
    subject: raw.subject ?? "(no subject)",
    from: formatAddresses(raw.from),
    receivedAt: new Date(raw.receivedAt),
    unread: !keywords["$seen"],
    snippet: raw.preview,
    keywords: Object.keys(keywords).filter(keyword => keywords[keyword]),
    ref,
  };
}

function toAgentAddresses(addresses: JmapEmailObject["from"] | null | undefined): FastmailAddress[] {
  return (addresses ?? []).map(address => ({ email: address.email, name: address.name ?? undefined }));
}

function toAgentMessage(email: JmapEmailObject, keywordOverlay: Record<string, boolean> | undefined): FastmailMessage {
  const keywords = mergeSimulatedKeywords(email.keywords, keywordOverlay);
  const textPartId = email.textBody?.[0]?.partId;
  const htmlPartId = email.htmlBody?.[0]?.partId;
  const attachments: FastmailAttachment[] = (email.attachments ?? []).map(attachment => ({
    filename: attachment.name ?? "attachment",
    mimeType: attachment.type,
    size: attachment.size,
    blobId: attachment.blobId,
  }));
  return {
    id: email.id,
    from: toAgentAddresses(email.from),
    to: toAgentAddresses(email.to),
    cc: toAgentAddresses(email.cc),
    subject: email.subject ?? "(no subject)",
    receivedAt: new Date(email.receivedAt),
    textBody: textPartId ? email.bodyValues?.[textPartId]?.value : undefined,
    htmlBody: htmlPartId ? email.bodyValues?.[htmlPartId]?.value : undefined,
    attachments,
    keywords: Object.keys(keywords).filter(keyword => keywords[keyword]),
  };
}

@validateRpc()
export class FastmailGatekeeperImpl extends DurableObject<Env, FastmailGatekeeperImplProps>
    implements Gatekeeper<FastmailSession> {
  #userAccount(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  async describe(): Promise<ResourceDescription> {
    const identity = await this.#userAccount().getIdentity();
    // A token without Email submission gets the session type with no way to send, so the agent is
    // never offered a method that can only fail. The runtime still refuses (`requireSender()`), and
    // Fastmail itself refuses EmailSubmission for such a token.
    const draftOnly = identity?.canSend === false;
    const scope = this.#scope;
    const account = identity?.email ? `${identity.email} on Fastmail` : "this Fastmail account";
    if (scope.kind === "mailbox") {
      const verbs = draftOnly ? "Read, organize, and draft" : "Read, organize, and send";
      return {
        url: toResourceUrl(),
        title: identity?.email ?? "Fastmail Mailbox",
        snippet: `${verbs} email through ${account}.`,
        suggestedBindingName: "FASTMAIL",
        tsType: draftOnly ? "FastmailDraftOnlySession" : "FastmailSession",
      };
    }
    const verbs = draftOnly ? "Read, organize, and draft replies to" : "Read, organize, and reply to";
    const where = scope.kind === "folder"
      ? `the folder "${await this.#folderName(scope.folderId)}"`
      : `mail matching: ${describeSearchFilter(
        scope.filter, scope.filter.folderId ? await this.#folderName(scope.filter.folderId) : undefined)}`;
    return {
      url: toResourceUrl(scope),
      title: `${identity?.email ?? "Fastmail"}: ${scope.kind === "folder" ? await this.#folderName(scope.folderId) : "saved search"}`,
      snippet: `${verbs} email in ${where}, in ${account}. Nothing outside it is visible.`,
      suggestedBindingName: "FASTMAIL",
      tsType: draftOnly ? "FastmailScopedDraftOnlySession" : "FastmailScopedSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  get #scope(): FastmailScope {
    return this.ctx.props.scope ?? MAILBOX_SCOPE;
  }

  /** A folder's name for display, or its id when it can't be looked up. */
  async #folderName(folderId: string): Promise<string> {
    try {
      const grant = await this.#userAccount().getGrant();
      const folders = await listMailboxes(grant.apiUrl, grant.apiToken, grant.accountId, grant.hasSubmission);
      return folders.find(folder => folder.id === folderId)?.name ?? folderId;
    } catch {
      return folderId;
    }
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return Object.values(AUTO_APPROVABLE_KINDS);
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<FastmailSession> {
    return new FastmailSessionImpl(
      approvalQueue.dup(), this.#userAccount(), this.ctx.storage.kv, this.env.WORKERS_AI,
      (queue, hook, folderId) => this.#subscribe(queue, hook, folderId), new ScopeGuard(this.#scope));
  }

  [restore](params: FastmailHookParams): FastmailHookDelivery {
    const folderId = params?.folderId;
    // Only a search binding's hook may watch without a folder: its search decides admission.
    if (folderId !== undefined ? typeof folderId !== "string" || !folderId : this.#scope.kind !== "search") {
      throw new TypeError("Invalid Fastmail hook params.");
    }
    return new FastmailHookDeliveryImpl(
      folderId, this.#userAccount(), this.ctx.storage.kv, this.env.WORKERS_AI, new ScopeGuard(this.#scope));
  }

  /** Bind a hook on new mail in `folderId`, or the inbox. Enabled only once the user approves. */
  async #subscribe(
    approvalQueue: RpcStub<ApprovalQueue>, hook: RpcStub<FastmailMessageHookTarget>, folderId: string | undefined,
  ): Promise<void> {
    const scope = this.#scope;
    const grant = await this.#userAccount().getGrant();
    const folders = await listMailboxes(grant.apiUrl, grant.apiToken, grant.accountId, grant.hasSubmission);
    if (scope.kind !== "mailbox" && folderId !== undefined && folderId !== new ScopeGuard(scope).boundFolderId) {
      throw new FastmailError(
        "INVALID_RESOURCE", "This Fastmail binding watches its own folder or search; leave out folderId.");
    }
    if (scope.kind === "search") {
      const searchFolder = scope.filter.folderId;
      const params: FastmailHookParams = searchFolder ? { folderId: searchFolder } : {};
      using delivery: RpcStub<FastmailHookDelivery> = await this.ctx.restore(params);
      const controller = this.ctx.exports.FastmailHookController({ props: {
        ...params,
        key: crypto.randomUUID(),
        userObjectId: this.ctx.props.userObjectId,
        delivery,
      } });
      const folderName = searchFolder ? folders.find(folder => folder.id === searchFolder)?.name : undefined;
      // @ts-expect-error Worker RPC's mapped types can't relate the controller's generic hook type.
      await approvalQueue.bindHook(controller, hook, {
        title: "Watch for new Fastmail messages",
        description: "Call this hook with each new message matching this binding's saved search (" +
          `${plainInline(describeSearchFilter(scope.filter, folderName))}), letting it read that message ` +
          "and queue replies and changes for approval.",
      });
      return;
    }
    const wanted = scope.kind === "folder" ? scope.folderId : folderId;
    const folder = wanted === undefined
      ? folders.find(mailbox => mailbox.role === "inbox")
      : folders.find(mailbox => mailbox.id === wanted);
    if (!folder) {
      throw new FastmailError("RESOURCE_NOT_FOUND", wanted === undefined
        ? "This Fastmail account has no inbox folder."
        : `Fastmail folder ${wanted} was not found. Use an id from listFolders().`);
    }
    const params: FastmailHookParams = { folderId: folder.id };
    using delivery: RpcStub<FastmailHookDelivery> = await this.ctx.restore(params);
    const controller = this.ctx.exports.FastmailHookController({ props: {
      ...params,
      key: crypto.randomUUID(),
      userObjectId: this.ctx.props.userObjectId,
      delivery,
    } });
    const name = plainInline(folder.name);
    const where = folder.role === "inbox" ? "the Fastmail inbox" : `the Fastmail folder "${name}"`;
    // @ts-expect-error Worker RPC's mapped types can't relate the controller's generic hook type.
    await approvalQueue.bindHook(controller, hook, {
      title: "Watch for new Fastmail messages",
      description: `Call this hook with each new message received in ${where}, letting it read that ` +
        "message and queue replies and changes for approval.",
    });
  }

  /** Action ids whose `applyAction()` is awaiting Fastmail in this instance. The input gate is open
   * across those awaits, so without this a second concurrent approval could apply the same record
   * twice now that it is only deleted once the side effect succeeds. */
  #applying = new Set<number>();

  /** Approved: perform the deferred side effect (a thread patch or a queued send), then clear any
   * simulation overlay a patch was showing.
   *
   * The pending record is deleted only once the side effect succeeds: the overseer leaves an action
   * pending when this throws, so a failed attempt (bad token, Fastmail rejecting the request) stays
   * approvable once the cause is fixed. A send whose response is lost after Fastmail accepted it
   * could therefore be sent again on retry — JMAP offers no idempotency key to prevent that. */
  async applyAction(actionId: number): Promise<void> {
    const pending = getPendingAction(this.ctx.storage.kv, actionId);
    if (!pending) {
      const error = new Error(`Unknown pending Fastmail action: ${actionId}`);
      logError("apply.unknownAction", error, { actionId, facetId: this.ctx.id.toString() });
      throw error;
    }
    if (this.#applying.has(actionId)) {
      throw new Error(`Fastmail action ${actionId} is already being applied.`);
    }
    this.#applying.add(actionId);
    try {
      const grant = await this.#userAccount().getGrant();
      await this.#call(async () => {
        if (pending.kind === "send") {
          const context = await resolveSendContext(
            grant.apiUrl, grant.apiToken, grant.accountId, pending.params.from);
          await sendEmail(grant.apiUrl, grant.apiToken, grant.accountId, pending.params, context);
        } else if (pending.kind === "draft") {
          await this.#withDraftLock(
            pending.draftId, () => applyDraftRevision(this.ctx.storage.kv, actionId, pending.draftId, grant));
        } else {
          await updateEmails(
            grant.apiUrl, grant.apiToken, grant.accountId, grant.hasSubmission, pending.emailIds,
            pending.patch);
        }
      });
    } catch (error) {
      logError("apply.failed", error, { actionId, kind: pending.kind });
      throw error;
    } finally {
      this.#applying.delete(actionId);
    }

    deletePendingAction(this.ctx.storage.kv, actionId);
    if (pending.kind === "patch") {
      for (const emailId of pending.emailIds) {
        clearSimulatedKeywordsIfLatest(this.ctx.storage.kv, emailId, actionId);
      }
    } else if (pending.kind === "send" && pending.answersEmailId) {
      // Best-effort, after the record is gone: the reply has already been sent, so failing (or
      // retrying) the approval over a missing "$answered" flag would be worse than the flag.
      const grant = await this.#userAccount().getGrant();
      await updateEmails(
        grant.apiUrl, grant.apiToken, grant.accountId, grant.hasSubmission, [pending.answersEmailId],
        { "keywords/$answered": true },
      ).catch(error => logError("apply.markAnsweredFailed", error, { actionId }));
    }
  }

  /** Tail of the apply chain per draft id. Applying a draft revision awaits Fastmail with the input
   * gate open, so two approvals for one draft would otherwise both see the same "previous" Email and
   * each write a copy. */
  #draftLocks = new Map<string, Promise<void>>();

  async #withDraftLock(draftId: string, fn: () => Promise<void>): Promise<void> {
    const run = (this.#draftLocks.get(draftId) ?? Promise.resolve()).then(fn);
    const tail = run.catch(() => {});
    this.#draftLocks.set(draftId, tail);
    try {
      await run;
    } finally {
      if (this.#draftLocks.get(draftId) === tail) this.#draftLocks.delete(draftId);
    }
  }

  async #call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof FastmailError && error.code === "AUTH_EXPIRED") {
        await this.#userAccount().noteCredentialsExpired();
        throw new Error(
          "Fastmail's API token has expired or been revoked. Please reconnect the account, then " +
          "approve this action again.",
          { cause: error });
      }
      throw error;
    }
  }

  /** Rejected: discard the queued side effect and its simulated view, if any. Nothing was ever sent
   * to Fastmail. */
  async rejectAction(actionId: number): Promise<void> {
    const pending = getPendingAction(this.ctx.storage.kv, actionId);
    deletePendingAction(this.ctx.storage.kv, actionId);
    if (pending?.kind === "draft") {
      rejectDraftRevision(this.ctx.storage.kv, actionId, pending.draftId);
      return;
    }
    if (pending?.kind !== "patch") return;
    for (const emailId of pending.emailIds) {
      clearSimulatedKeywordsIfLatest(this.ctx.storage.kv, emailId, actionId);
    }
  }

  async revertAction(_actionId: number): Promise<{ message: string; canRetry: boolean }> {
    return {
      message:
          "This change can't be reverted automatically. Move the message back, re-apply the " +
          "keyword, or edit the draft yourself in Fastmail.",
      canRetry: false,
    };
  }

  /**
   * Observer tracking — strategy A (private-only, see write-gatekeeper skill "Observer
   * verification"). A bound mailbox is one person's private email and Fastmail gives us no
   * per-observer ACL oracle to check another connected account against, so no collaborator may
   * observe data read through this binding.
   */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    throw new Error(
      "This Fastmail mailbox cannot be shared with other users: it may only be observed by the " +
      "person who connected it.");
  }

  async removeObserver(_id: string): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Sending, shared by FastmailSessionImpl.send() and FastmailThreadImpl.reply()

function nextActionId(kv: DurableObjectStorage["kv"]): number {
  const actionId = kv.get<number>("action:nextId") ?? 1;
  kv.put("action:nextId", actionId + 1);
  return actionId;
}

/**
 * Action kinds a user may opt in to auto-approving. Every one only prepares or organizes mail inside
 * the account; sending (`send`, `reply`, a draft's `send`) carries no kind, so it always waits for
 * a person.
 */
const AUTO_APPROVABLE_KINDS = {
  draftCreate: { tag: "draftCreate", label: "Create an email draft" },
  draftUpdate: { tag: "draftUpdate", label: "Edit an email draft" },
  draftDelete: { tag: "draftDelete", label: "Discard an email draft" },
  readState: { tag: "readState", label: "Mark email read or unread" },
  keyword: { tag: "keyword", label: "Add or remove an email keyword" },
  move: { tag: "move", label: "Move email to another folder" },
} satisfies Record<string, ActionKind>;

function autoApprovable(kind: ActionKind): { actionKind: ActionKind; autoApprovable: true } {
  return { actionKind: kind, autoApprovable: true };
}

/** Whether `requireSender()` would succeed for this grant. */
function canSend(grant: StoredGrant): boolean {
  return grant.hasSubmission && grant.identityEmail !== undefined;
}

/** The address to send from, or a `SUBMISSION_NOT_AUTHORIZED` error if this grant cannot send. */
function requireSender(grant: StoredGrant): string {
  if (!grant.hasSubmission) {
    throw new FastmailError(
      "SUBMISSION_NOT_AUTHORIZED",
      "This Fastmail connection's API token does not grant Email submission, so it cannot send " +
      "mail. Reconnect with a token that includes Email submission scope to enable sending.");
  }
  if (!grant.identityEmail) {
    throw new FastmailError(
      "SUBMISSION_NOT_AUTHORIZED", "Could not determine this account's own address to send from.");
  }
  return grant.identityEmail;
}

/** The `From` for a draft: the sending identity when known, else the session's login address. */
function draftSender(grant: StoredGrant): string | undefined {
  return grant.identityEmail ?? grant.username;
}

function toJmapAddresses(addresses: FastmailAddress[] | undefined): SendEmailParams["to"] | undefined {
  return addresses?.map(address => ({ email: address.email, name: address.name }));
}

/** The params of a reply to `source`, as `reply()` sends it and `createReplyDraft()` saves it. */
function replyContent(
  source: JmapReplySource, from: string | undefined, body: { text?: string; html?: string },
  options: { replyAll?: boolean; cc?: FastmailAddress[]; bcc?: FastmailAddress[] } | undefined,
): DraftContent {
  const recipients = replyRecipients(source, from ?? "", options?.replyAll ?? false);
  const cc = [...recipients.cc, ...toJmapAddresses(options?.cc) ?? []];
  if (recipients.to.length === 0 && cc.length === 0) {
    throw new FastmailError("RESOURCE_NOT_FOUND", "Could not determine who to reply to.");
  }
  const subject = source.subject ?? "";
  const messageIds = source.messageId ?? [];
  return {
    to: recipients.to,
    cc: cc.length > 0 ? cc : undefined,
    bcc: toJmapAddresses(options?.bcc),
    subject: /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`,
    textBody: body.text,
    htmlBody: body.html,
    inReplyTo: messageIds.length > 0 ? messageIds : undefined,
    references: messageIds.length > 0 ? [...source.references ?? [], ...messageIds] : undefined,
  };
}

// ---------------------------------------------------------------------------
// Drafts, shared by FastmailSessionImpl, FastmailThreadImpl, and FastmailDraftImpl

type DraftContext = {
  approvalQueue: RpcStub<ApprovalQueue>;
  account: DurableObjectStub<UserAccount>;
  kv: DurableObjectStorage["kv"];
};

/**
 * Records `revision` as pending on `record` and queues it for approval. The record is written
 * before the only await, so a concurrent call on the same draft (which re-reads the record) sees it.
 * Like `stageSend()`, nothing is cleaned up if `submitAction()` throws: the overseer may already have
 * committed the action.
 */
async function stageDraftRevision(
  ctx: DraftContext, record: DraftRecord, revision: DraftRevision, title: string,
  description: RenderedDescription, kind: ActionKind | undefined,
): Promise<void> {
  const actionId = nextActionId(ctx.kv);
  record.pending[actionId] = revision;
  putDraftRecord(ctx.kv, record);
  setPendingAction(ctx.kv, actionId, { kind: "draft", draftId: record.id });
  await ctx.approvalQueue.submitAction(actionId, {
    title,
    ...description,
    implementsRevert: false,
    ...kind ? autoApprovable(kind) : {},
  });
}

/** Creates a draft record for `content` and queues saving it to Drafts. */
async function createDraftRecord(
  ctx: DraftContext, from: string | undefined, content: DraftContent, answersEmailId?: string,
): Promise<FastmailDraftImpl> {
  const record: DraftRecord = { id: crypto.randomUUID(), from, answersEmailId, pending: {} };
  await stageDraftRevision(
    ctx, record, { kind: "content", content, at: Date.now() },
    answersEmailId ? "Save reply draft" : "Create email draft",
    describeSend(
      `Save a new ${answersEmailId ? "reply " : ""}draft in this Fastmail account's Drafts folder. ` +
      "Nothing is sent.",
      { from, ...content }),
    AUTO_APPROVABLE_KINDS.draftCreate);
  return new FastmailDraftImpl(ctx.approvalQueue.dup(), ctx.account, ctx.kv, record.id);
}

async function stageSend(
  approvalQueue: RpcStub<ApprovalQueue>, kv: DurableObjectStorage["kv"],
  pending: { params: SendEmailParams; answersEmailId?: string }, title: string,
): Promise<void> {
  const actionId = nextActionId(kv);
  setPendingAction(kv, actionId, { kind: "send", ...pending });
  // Not cleaned up on a thrown error: the overseer commits the action record durably before
  // submitAction() returns, so a failure reaching this await (e.g. a dropped RPC response) can
  // mean the submission actually succeeded server-side even though this call sees an error.
  // Deleting the pending record here would then permanently orphan an action the overseer still
  // considers pending and approvable — applyAction() would find nothing when it's later approved.
  // An orphaned record from a genuine pre-commit rejection is harmless (never referenced again).
  const { params } = pending;
  try {
    await approvalQueue.submitAction(actionId, {
      title,
      ...describeSend(
        `${title} from this Fastmail account. Sending can't be undone.`, params),
      // Sending is irreversible: EmailSubmission has no "unsend".
      implementsRevert: false,
    });
  } catch (error) {
    logError("send.submitFailed", error, { actionId });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// SessionImpl — the RPC interface exposed to the Gadget

@validateRpc()
export class FastmailSessionImpl extends RpcTarget implements FastmailSession {
  #approvalQueue: RpcStub<ApprovalQueue>;
  #account: DurableObjectStub<UserAccount>;
  #kv: DurableObjectStorage["kv"];
  #ai: Ai;
  #subscribe: SubscribeNewMessages | undefined;
  #guard: ScopeGuard;

  constructor(
      approvalQueue: RpcStub<ApprovalQueue>, account: DurableObjectStub<UserAccount>,
      kv: DurableObjectStorage["kv"], ai: Ai, subscribe?: SubscribeNewMessages,
      guard: ScopeGuard = new ScopeGuard()) {
    super();
    this.#approvalQueue = approvalQueue;
    this.#account = account;
    this.#kv = kv;
    this.#ai = ai;
    this.#subscribe = subscribe;
    this.#guard = guard;
  }

  get #ctx(): CapabilityContext {
    return { approvalQueue: this.#approvalQueue, account: this.#account, kv: this.#kv, ai: this.#ai, guard: this.#guard };
  }

  [Symbol.dispose]() {
    this.#approvalQueue[Symbol.dispose]();
  }

  async #call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      logError("jmap.failed", error);
      if (error instanceof FastmailError && error.code === "AUTH_EXPIRED") {
        await this.#account.noteCredentialsExpired();
        throw new Error(
          "Fastmail's API token has expired or been revoked. Please reconnect the account.",
          { cause: error });
      }
      throw error;
    }
  }

  async listFolders(): Promise<FastmailFolder[]> {
    const now = Date.now();
    const cached = getCachedFolders(this.#kv, now);
    if (cached) {
      await this.#approvalQueue.authorizeObservation({
        title: "List Fastmail folders",
        description: "List the folders in this Fastmail mailbox (cached).",
      });
      return this.#guard.visibleFolders(cached).map(toAgentFolder);
    }

    const grant = await this.#account.getGrant();
    const folders = await this.#call(() =>
      listMailboxes(grant.apiUrl, grant.apiToken, grant.accountId, grant.hasSubmission));
    putCachedFolders(this.#kv, folders, now);
    await this.#approvalQueue.authorizeObservation({
      title: "List Fastmail folders",
      description: "List the folders in this Fastmail mailbox.",
    });
    return this.#guard.visibleFolders(folders).map(toAgentFolder);
  }

  #threadCursor(caller: { inMailbox?: string; text?: string }): Cursor<FastmailThreadEntry> {
    // Before dup(): a folder outside the binding throws without leaking a stub.
    const filter = this.#guard.listFilter(caller);
    const approvalQueue = this.#approvalQueue.dup();
    const kv = this.#kv;
    const account = this.#account;
    const call = this.#call.bind(this);
    return new OffsetCursor<FastmailThreadEntry>({
      pageSize: 25,
      dispose: () => approvalQueue[Symbol.dispose](),
      fetchPage: async (offset, limit) => {
        const grant = await account.getGrant();
        const raw = await call(() => queryThreadPage(
          grant.apiUrl, grant.apiToken, grant.accountId, grant.hasSubmission, filter, offset, limit));
        return raw.map(entry => toThreadEntry(entry, getSimulatedKeywords(kv, entry.id)));
      },
      authorizePage: (items, { terminal }) => approvalQueue.authorizeObservation({
        title: "List Fastmail threads",
        description: terminal && items.length === 0
          ? "Listed Fastmail threads; there were none matching."
          : `Read ${items.length} Fastmail thread(s).`,
      }),
    });
  }

  async listThreads(folderId?: string): Promise<Cursor<FastmailThreadEntry>> {
    return this.#threadCursor(folderId ? { inMailbox: folderId } : {});
  }

  async searchThreads(query: string, folderId?: string): Promise<Cursor<FastmailThreadEntry>> {
    return this.#threadCursor(folderId ? { inMailbox: folderId, text: query } : { text: query });
  }

  async getThread(threadId: string): Promise<FastmailThread> {
    const grant = await this.#account.getGrant();
    return openThread(this.#ctx, grant, threadId);
  }

  #messageCursor(caller: { inMailbox?: string; text?: string }): Cursor<FastmailMessageEntry> {
    // Before dup(): a folder outside the binding throws without leaking a stub.
    const filter = this.#guard.listFilter(caller);
    const ctx = { ...this.#ctx, approvalQueue: this.#approvalQueue.dup() };
    const call = this.#call.bind(this);
    return new OffsetCursor<FastmailMessageEntry>({
      pageSize: 25,
      dispose: () => ctx.approvalQueue[Symbol.dispose](),
      fetchPage: async (offset, limit) => {
        const grant = await ctx.account.getGrant();
        const raw = await call(() => queryMessagePage(
          grant.apiUrl, grant.apiToken, grant.accountId, grant.hasSubmission, filter, offset, limit));
        return raw.map(entry => toMessageEntry(
          entry, getSimulatedKeywords(ctx.kv, entry.id),
          new FastmailMessageRefImpl({ ...ctx, approvalQueue: ctx.approvalQueue.dup() }, entry.id)));
      },
      authorizePage: (items, { terminal }) => ctx.approvalQueue.authorizeObservation({
        title: "List Fastmail messages",
        description: terminal && items.length === 0
          ? "Listed Fastmail messages; there were none matching."
          : `Read ${items.length} Fastmail message summary(ies).`,
      }),
    });
  }

  async listMessages(folderId?: string): Promise<Cursor<FastmailMessageEntry>> {
    return this.#messageCursor(folderId ? { inMailbox: folderId } : {});
  }

  async searchMessages(query: string, folderId?: string): Promise<Cursor<FastmailMessageEntry>> {
    return this.#messageCursor(folderId ? { inMailbox: folderId, text: query } : { text: query });
  }

  async getMessage(id: string): Promise<FastmailMessageRef> {
    if (!/^[A-Za-z0-9_-]{1,255}$/.test(id)) throw outOfScope("That message");
    const grant = await this.#account.getGrant();
    const infos = await this.#call(() =>
      getAdmissionInfo(grant.apiUrl, grant.apiToken, grant.accountId, grant.hasSubmission, [id]));
    const admitted = await this.#call(() => this.#guard.admitInfos(grant, infos));
    if (!admitted.has(id)) throw outOfScope("That message");
    return new FastmailMessageRefImpl({ ...this.#ctx, approvalQueue: this.#approvalQueue.dup() }, id);
  }

  async send(
    to: FastmailAddress[], subject: string, body: { text?: string; html?: string },
    options?: { cc?: FastmailAddress[]; bcc?: FastmailAddress[] },
  ): Promise<void> {
    this.#guard.requireWholeMailbox("send new mail");
    const grant = await this.#account.getGrant();
    await stageSend(this.#approvalQueue, this.#kv, {
      params: {
        from: requireSender(grant),
        to: toJmapAddresses(to) ?? [],
        cc: toJmapAddresses(options?.cc),
        bcc: toJmapAddresses(options?.bcc),
        subject,
        textBody: body.text,
        htmlBody: body.html,
      },
    }, "Send email");
  }

  async createDraft(draft: FastmailDraftInput): Promise<FastmailSendableDraft> {
    this.#guard.requireWholeMailbox("draft new mail");
    const grant = await this.#account.getGrant();
    return createDraftRecord(
      { approvalQueue: this.#approvalQueue, account: this.#account, kv: this.#kv },
      draftSender(grant), {
        to: toJmapAddresses(draft.to) ?? [],
        cc: toJmapAddresses(draft.cc),
        bcc: toJmapAddresses(draft.bcc),
        subject: draft.subject ?? "",
        textBody: draft.text,
        htmlBody: draft.html,
      });
  }

  async listDrafts(): Promise<FastmailDraftInfo[]> {
    const drafts: FastmailDraftInfo[] = [];
    for (const record of listDraftRecords(this.#kv)) {
      const current = currentDraftRevision(record);
      if (current?.revision.kind === "content") {
        drafts.push(toDraftInfo(record, current.revision.content, current.revision.at));
      }
    }
    await this.#approvalQueue.authorizeObservation({
      title: "List Fastmail drafts",
      description: `Listed ${drafts.length} draft(s) created through this connection.`,
    });
    return drafts;
  }

  async getDraft(id: string): Promise<FastmailSendableDraft> {
    currentDraft(this.#kv, id);
    return new FastmailDraftImpl(this.#approvalQueue.dup(), this.#account, this.#kv, id);
  }

  async subscribeNewMessages(
    hook: RpcStub<FastmailMessageHookTarget>, options?: { folderId?: string },
  ): Promise<void> {
    if (!this.#subscribe) throw new Error("This Fastmail session can't watch for new mail.");
    await this.#call(() => this.#subscribe!(this.#approvalQueue, hook, options?.folderId));
  }
}

/** Binds a new-mail hook through the session's approval queue; see `FastmailGatekeeperImpl.#subscribe()`. */
type SubscribeNewMessages = (
  approvalQueue: RpcStub<ApprovalQueue>, hook: RpcStub<FastmailMessageHookTarget>, folderId: string | undefined,
) => Promise<void>;

// ---------------------------------------------------------------------------
// Hook delivery

/**
 * What a hook's delivery stub restores to: one firing at a time, of an email only if it is (still)
 * new mail in the hook's folder. The driver (hooks.ts) decides when to call it; this decides what
 * the hook may see, as opening a session does.
 */
@validateRpc()
export class FastmailHookDeliveryImpl extends RpcTarget implements FastmailHookDelivery {
  constructor(
    /** The folder the hook watches; absent for a search binding's hook, which watches its search. */
    private readonly folderId: string | undefined,
    private readonly account: DurableObjectStub<UserAccount>,
    private readonly kv: DurableObjectStorage["kv"],
    private readonly ai: Ai,
    private readonly guard: ScopeGuard = new ScopeGuard(),
  ) {
    super();
  }

  async admits(emailId: string): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{1,255}$/.test(emailId)) throw new TypeError("Invalid Fastmail email id.");
    const grant = await this.account.getGrant();
    const [info] = await getAdmissionInfo(
      grant.apiUrl, grant.apiToken, grant.accountId, grant.hasSubmission, [emailId]);
    if (!info || info.keywords?.["$draft"]) return false;
    if (this.folderId !== undefined && !info.mailboxIds?.[this.folderId]) return false;
    return (await this.guard.admitInfos(grant, [info])).has(emailId);
  }

  async deliver(callback: RpcStub<FastmailMessageHookTarget>, approvalQueue: RpcStub<ApprovalQueue>,
                emailId: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,255}$/.test(emailId)) throw new TypeError("Invalid Fastmail email id.");
    const grant = await this.account.getGrant();
    let email: JmapEmailObject | undefined;
    let messageIds: string[];
    try {
      [email] = await getMessages(
        grant.apiUrl, grant.apiToken, grant.accountId, grant.hasSubmission, [emailId]);
      // Deleted since it arrived, filed elsewhere, or not mail at all.
      if (!email || email.id !== emailId || email.keywords?.["$draft"]) return;
      if (this.folderId !== undefined && !email.mailboxIds?.[this.folderId]) return;
      // The binding's own scope decides too: a search binding's hook sees only mail matching it.
      if ((await this.guard.admit(grant, [emailId])).length === 0) return;
      const thread = await getThreadMetadata(
        grant.apiUrl, grant.apiToken, grant.accountId, grant.hasSubmission, email.threadId);
      messageIds = await this.guard.admit(grant, thread.messageIds);
    } catch (error) {
      if (error instanceof FastmailError && error.code === "AUTH_EXPIRED") {
        await this.account.noteCredentialsExpired();
      }
      if (error instanceof FastmailError && error.code === "RESOURCE_NOT_FOUND") return;
      throw error;
    }

    const message = toAgentMessage(email, getSimulatedKeywords(this.kv, email.id));
    await approvalQueue.authorizeObservation({
      title: `New Fastmail message: ${message.subject}`.slice(0, 200),
      description: "Read a new message this hook watches for: its sender, recipients, " +
        "date, subject, keywords, body, and attachments' names.",
    });
    const ctx: CapabilityContext = { approvalQueue, account: this.account, kv: this.kv, ai: this.ai, guard: this.guard };
    using thread = new FastmailThreadImpl(
      approvalQueue.dup(), this.account, this.kv, messageIds.length > 0 ? messageIds : [emailId], this.ai, this.guard);
    using ref = new FastmailMessageRefImpl({ ...ctx, approvalQueue: approvalQueue.dup() }, emailId);
    await callback.receiveMessage({ message, folderId: this.folderId ?? null, thread, ref });
  }
}

// ---------------------------------------------------------------------------
// MessageSet — what a thread and a single message share: a fixed set of email ids, read and changed
// only as far as the binding's scope admits them now.

/** Everything a capability handed to the Gadget needs. */
type CapabilityContext = {
  approvalQueue: RpcStub<ApprovalQueue>;
  account: DurableObjectStub<UserAccount>;
  kv: DurableObjectStorage["kv"];
  ai: Ai;
  guard: ScopeGuard;
};

async function callFastmail<T>(account: DurableObjectStub<UserAccount>, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    logError("jmap.failed", error);
    if (error instanceof FastmailError && error.code === "AUTH_EXPIRED") {
      await account.noteCredentialsExpired();
      throw new Error(
        "Fastmail's API token has expired or been revoked. Please reconnect the account.",
        { cause: error });
    }
    throw error;
  }
}

class MessageSet {
  constructor(
    private readonly ctx: CapabilityContext,
    /** The ids this capability was opened with, already admitted at the time. */
    private readonly messageIds: string[],
    /** "thread" or "message", for approval titles and descriptions. */
    private readonly noun: "thread" | "message",
  ) {}

  #call<T>(fn: () => Promise<T>): Promise<T> {
    return callFastmail(this.ctx.account, fn);
  }

  /** The ids the scope still admits, refusing when none are left. */
  async admitted(grant: StoredGrant): Promise<string[]> {
    const ids = await this.#call(() => this.ctx.guard.admit(grant, this.messageIds));
    if (ids.length === 0) throw outOfScope(this.noun === "thread" ? "That thread" : "That message");
    return ids;
  }

  async emails(grant: StoredGrant): Promise<JmapEmailObject[]> {
    const ids = await this.admitted(grant);
    return this.#call(() => getMessages(grant.apiUrl, grant.apiToken, grant.accountId, grant.hasSubmission, ids));
  }

  async messages(): Promise<FastmailMessage[]> {
    const grant = await this.ctx.account.getGrant();
    const emails = await this.emails(grant);
    await this.ctx.approvalQueue.authorizeObservation({
      title: this.noun === "thread" ? "Read Fastmail thread" : "Read Fastmail message",
      description: this.noun === "thread"
        ? `Read ${emails.length} message(s) in this thread.`
        : "Read one message: its sender, recipients, date, subject, keywords, body, and attachments' names.",
    });
    return emails.map(email => toAgentMessage(email, getSimulatedKeywords(this.ctx.kv, email.id)));
  }

  async reply(
    body: { text?: string; html?: string },
    options?: { replyAll?: boolean; cc?: FastmailAddress[]; bcc?: FastmailAddress[] },
  ): Promise<void> {
    const grant = await this.ctx.account.getGrant();
    const from = requireSender(grant);
    const source = await this.#replySource(grant);
    await stageSend(this.ctx.approvalQueue, this.ctx.kv, {
      params: { from, ...replyContent(source, from, body, options) },
      answersEmailId: source.id,
    }, "Reply to email");
  }

  async createReplyDraft(
    body: { text?: string; html?: string },
    options?: { replyAll?: boolean; cc?: FastmailAddress[]; bcc?: FastmailAddress[] },
  ): Promise<FastmailSendableDraft> {
    const grant = await this.ctx.account.getGrant();
    const from = draftSender(grant);
    const source = await this.#replySource(grant);
    return createDraftRecord(
      { approvalQueue: this.ctx.approvalQueue, account: this.ctx.account, kv: this.ctx.kv },
      from, replyContent(source, from, body, options), source.id);
  }

  /** The newest admitted message: what a reply answers. */
  async #replySource(grant: StoredGrant): Promise<JmapReplySource> {
    const ids = await this.admitted(grant);
    const source = await this.#call(() => getReplySource(
      grant.apiUrl, grant.apiToken, grant.accountId, grant.hasSubmission, ids));
    if (!source) throw new FastmailError("RESOURCE_NOT_FOUND", `This ${this.noun} has no message to reply to.`);
    return source;
  }

  /** The attachment `blobId` names, refusing a blob that isn't on an admitted message here. */
  async #attachment(grant: StoredGrant, blobId: string): Promise<JmapAttachment> {
    const emails = await this.emails(grant);
    const attachment = emails.flatMap(email => email.attachments ?? []).find(a => a.blobId === blobId);
    if (!attachment) {
      throw new FastmailError(
        "RESOURCE_NOT_FOUND", `That attachment does not belong to ${this.noun === "thread" ? "a message in this thread" : "this message"}.`);
    }
    return attachment;
  }

  async readAttachment(blobId: string): Promise<ArrayBuffer> {
    const grant = await this.ctx.account.getGrant();
    const attachment = await this.#attachment(grant, blobId);
    const content = await this.#call(() => downloadBlob(
      grant.downloadUrlTemplate, grant.apiToken, grant.accountId, blobId,
      attachment.name ?? "attachment", attachment.type));
    await this.ctx.approvalQueue.authorizeObservation({
      title: "Download Fastmail attachment",
      description: `Downloaded ${attachment.name ?? blobId} (${content.byteLength} bytes).`,
    });
    return content;
  }

  /**
   * Reuses `readAttachment()`'s attachment lookup (still required on every call, cache hit or not
   * -- it's what confirms `blobId` actually belongs to an admitted message here, not just any blob
   * in the account). A `blobId`'s content is immutable, so a cache hit skips both the download and
   * the conversion.
   */
  async readAttachmentAsMarkdown(blobId: string): Promise<FastmailMarkdownContent> {
    const grant = await this.ctx.account.getGrant();
    const attachment = await this.#attachment(grant, blobId);
    assertMarkdownConvertible(attachment.type, attachment.size);

    const cached = getCachedAttachmentMarkdown(this.ctx.kv, blobId);
    if (cached) {
      await this.ctx.approvalQueue.authorizeObservation({
        title: "Download Fastmail attachment as Markdown",
        description: `Converted ${attachment.name ?? blobId} to Markdown (cached).`,
      });
      return cached;
    }

    const content = await this.#call(() => downloadBlob(
      grant.downloadUrlTemplate, grant.apiToken, grant.accountId, blobId,
      attachment.name ?? "attachment", attachment.type));
    const markdown = await convertToMarkdown(this.ctx.ai, attachment.name ?? blobId, attachment.type, content);
    const result: FastmailMarkdownContent = { markdown, sourceMimeType: attachment.type };
    putCachedAttachmentMarkdown(this.ctx.kv, blobId, result);
    await this.ctx.approvalQueue.authorizeObservation({
      title: "Download Fastmail attachment as Markdown",
      description: `Converted ${attachment.name ?? blobId} to Markdown (${content.byteLength} bytes source).`,
    });
    return result;
  }

  /**
   * Who sent which of the target messages, so the approver can tell what a change touches.
   * Best-effort: a failed lookup leaves the description with the message count only, rather than
   * failing the action.
   */
  async #messageSummaries(grant: StoredGrant, ids: string[]): Promise<MessageSummary[] | undefined> {
    try {
      const emails = await getMessages(grant.apiUrl, grant.apiToken, grant.accountId, grant.hasSubmission, ids);
      return emails.map(email => ({
        from: email.from?.map(formatAddress).join(", ") || "(no sender)",
        subject: email.subject || "(no subject)",
        receivedAt: email.receivedAt,
      }));
    } catch (error) {
      logError("approval.summaryFailed", error);
      return undefined;
    }
  }

  /** The folders this binding may name, cached like `listFolders()`. */
  async #visibleFolders(grant: StoredGrant): Promise<JmapMailboxObject[]> {
    const now = Date.now();
    let folders = getCachedFolders(this.ctx.kv, now);
    if (!folders) {
      folders = await this.#call(() =>
        listMailboxes(grant.apiUrl, grant.apiToken, grant.accountId, grant.hasSubmission));
      putCachedFolders(this.ctx.kv, folders, now);
    }
    return this.ctx.guard.visibleFolders(folders);
  }

  #changeIntro(whole: string, single: string): string {
    return this.noun === "thread" ? whole : single;
  }

  async moveToFolder(folderId: string): Promise<void> {
    const grant = await this.ctx.account.getGrant();
    let folderName: string;
    try {
      const folder = (await this.#visibleFolders(grant)).find(candidate => candidate.id === folderId);
      // A narrowed binding may only file mail into the folders it can see (see ScopeGuard).
      if (!folder && this.ctx.guard.restricted) throw outOfScope("That folder");
      folderName = folder?.name ?? folderId;
    } catch (error) {
      if (this.ctx.guard.restricted) throw error;
      // The whole mailbox may name any folder; the lookup only labels it for the approver.
      logError("approval.folderLookupFailed", error);
      folderName = folderId;
    }
    const ids = await this.admitted(grant);
    const summaries = await this.#messageSummaries(grant, ids);
    const patch = { mailboxIds: { [folderId]: true } };
    const actionId = nextActionId(this.ctx.kv);
    setPendingAction(this.ctx.kv, actionId, { kind: "patch", emailIds: ids, patch });
    // Not cleaned up on a thrown error — see the matching comment in stageSend(): the overseer
    // commits the action record before submitAction() returns, so deleting the local record on a
    // failed await could orphan a genuinely-pending, still-approvable action.
    await this.ctx.approvalQueue.submitAction(actionId, {
      title: this.noun === "thread" ? "Move Fastmail thread" : "Move Fastmail message",
      ...describeThreadChange(
        this.#changeIntro("Move every message in this thread to another folder.", "Move this message to another folder."),
        ids.length, summaries, [{ label: "To folder", value: folderName }]),
      implementsRevert: false,
      ...autoApprovable(AUTO_APPROVABLE_KINDS.move),
    });
  }

  async patchKeyword(keyword: string, present: boolean): Promise<void> {
    const grant = await this.ctx.account.getGrant();
    const ids = await this.admitted(grant);
    const summaries = await this.#messageSummaries(grant, ids);
    const actionId = nextActionId(this.ctx.kv);
    setPendingAction(this.ctx.kv, actionId, {
      kind: "patch",
      emailIds: ids,
      patch: { [`keywords/${keyword}`]: present ? true : null },
    });
    for (const emailId of ids) {
      setSimulatedKeywords(this.ctx.kv, emailId, actionId, { [keyword]: present });
    }
    // Neither the pending action record nor the simulated overlay is cleaned up on a thrown error —
    // see the matching comment in stageSend(): the overseer commits the action record before
    // submitAction() returns, so a failure reaching this await can mean the submission actually
    // succeeded server-side. Clearing either here could desync this session's view (or orphan a
    // still-approvable action) from what the overseer actually recorded.
    const noun = this.noun === "thread" ? "thread" : "message";
    const title = keyword === "$seen"
      ? `Mark Fastmail ${noun} ${present ? "read" : "unread"}`
      : present ? "Add Fastmail keyword" : "Remove Fastmail keyword";
    const intro = keyword === "$seen"
      ? this.#changeIntro(
        `Mark every message in this thread as ${present ? "read" : "unread"}.`,
        `Mark this message as ${present ? "read" : "unread"}.`)
      : this.#changeIntro(
        `${present ? "Add a keyword to" : "Remove a keyword from"} every message in this thread.`,
        `${present ? "Add a keyword to" : "Remove a keyword from"} this message.`);
    await this.ctx.approvalQueue.submitAction(actionId, {
      title,
      ...describeThreadChange(
        intro, ids.length, summaries, keyword === "$seen" ? [] : [{ label: "Keyword", value: keyword }]),
      implementsRevert: false,
      ...autoApprovable(keyword === "$seen" ? AUTO_APPROVABLE_KINDS.readState : AUTO_APPROVABLE_KINDS.keyword),
    });
  }
}

// ---------------------------------------------------------------------------
// ThreadImpl — the RPC interface exposed to the Gadget for one open thread

@validateRpc()
export class FastmailThreadImpl extends RpcTarget implements FastmailThread {
  #ctx: CapabilityContext;
  #set: MessageSet;

  constructor(
      approvalQueue: RpcStub<ApprovalQueue>, account: DurableObjectStub<UserAccount>,
      kv: DurableObjectStorage["kv"], messageIds: string[], ai: Ai, guard: ScopeGuard = new ScopeGuard()) {
    super();
    this.#ctx = { approvalQueue, account, kv, ai, guard };
    this.#set = new MessageSet(this.#ctx, messageIds, "thread");
  }

  [Symbol.dispose]() {
    this.#ctx.approvalQueue[Symbol.dispose]();
  }

  messages(): Promise<FastmailMessage[]> {
    return this.#set.messages();
  }

  reply(
    body: { text?: string; html?: string },
    options?: { replyAll?: boolean; cc?: FastmailAddress[]; bcc?: FastmailAddress[] },
  ): Promise<void> {
    return this.#set.reply(body, options);
  }

  createReplyDraft(
    body: { text?: string; html?: string },
    options?: { replyAll?: boolean; cc?: FastmailAddress[]; bcc?: FastmailAddress[] },
  ): Promise<FastmailSendableDraft> {
    return this.#set.createReplyDraft(body, options);
  }

  readAttachment(blobId: string): Promise<ArrayBuffer> {
    return this.#set.readAttachment(blobId);
  }

  readAttachmentAsMarkdown(blobId: string): Promise<FastmailMarkdownContent> {
    return this.#set.readAttachmentAsMarkdown(blobId);
  }

  moveToFolder(folderId: string): Promise<void> {
    return this.#set.moveToFolder(folderId);
  }

  addKeyword(keyword: string): Promise<void> {
    return this.#set.patchKeyword(keyword, true);
  }

  removeKeyword(keyword: string): Promise<void> {
    return this.#set.patchKeyword(keyword, false);
  }

  markRead(): Promise<void> {
    return this.#set.patchKeyword("$seen", true);
  }

  markUnread(): Promise<void> {
    return this.#set.patchKeyword("$seen", false);
  }
}

/** Opens a thread capability over the messages of `threadId` the guard admits, or refuses. */
async function openThread(ctx: CapabilityContext, grant: StoredGrant, threadId: string): Promise<FastmailThreadImpl> {
  let metadata: { messageIds: string[] };
  try {
    metadata = await callFastmail(ctx.account, () =>
      getThreadMetadata(grant.apiUrl, grant.apiToken, grant.accountId, grant.hasSubmission, threadId));
  } catch (error) {
    // The same refusal as for a thread outside the scope, so a narrowed binding can't probe ids.
    if (error instanceof FastmailError && error.code === "RESOURCE_NOT_FOUND") throw outOfScope("That thread");
    throw error;
  }
  const admitted = await callFastmail(ctx.account, () => ctx.guard.admit(grant, metadata.messageIds));
  if (admitted.length === 0) throw outOfScope("That thread");
  return new FastmailThreadImpl(ctx.approvalQueue.dup(), ctx.account, ctx.kv, admitted, ctx.ai, ctx.guard);
}

// ---------------------------------------------------------------------------
// MessageRefImpl — the RPC interface exposed to the Gadget for one message

@validateRpc()
export class FastmailMessageRefImpl extends RpcTarget implements FastmailMessageRef {
  #ctx: CapabilityContext;
  #emailId: string;
  #set: MessageSet;

  constructor(ctx: CapabilityContext, emailId: string) {
    super();
    this.#ctx = ctx;
    this.#emailId = emailId;
    this.#set = new MessageSet(ctx, [emailId], "message");
  }

  [Symbol.dispose]() {
    this.#ctx.approvalQueue[Symbol.dispose]();
  }

  async read(): Promise<FastmailMessage> {
    const [message] = await this.#set.messages();
    if (!message) throw outOfScope("That message");
    return message;
  }

  async getHeaders(): Promise<{ name: string; value: string }[]> {
    const grant = await this.#ctx.account.getGrant();
    await this.#set.admitted(grant);
    const headers = await callFastmail(this.#ctx.account, () => getEmailHeaders(
      grant.apiUrl, grant.apiToken, grant.accountId, grant.hasSubmission, this.#emailId));
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Read Fastmail message headers",
      description: `Read all ${headers.length} header field(s) of one message.`,
    });
    return headers;
  }

  async thread(): Promise<FastmailThread> {
    const grant = await this.#ctx.account.getGrant();
    await this.#set.admitted(grant);
    const [info] = await callFastmail(this.#ctx.account, () => getAdmissionInfo(
      grant.apiUrl, grant.apiToken, grant.accountId, grant.hasSubmission, [this.#emailId]));
    if (!info) throw outOfScope("That message");
    return openThread(this.#ctx, grant, info.threadId);
  }

  readAttachment(blobId: string): Promise<ArrayBuffer> {
    return this.#set.readAttachment(blobId);
  }

  readAttachmentAsMarkdown(blobId: string): Promise<FastmailMarkdownContent> {
    return this.#set.readAttachmentAsMarkdown(blobId);
  }

  moveToFolder(folderId: string): Promise<void> {
    return this.#set.moveToFolder(folderId);
  }

  addKeyword(keyword: string): Promise<void> {
    return this.#set.patchKeyword(keyword, true);
  }

  removeKeyword(keyword: string): Promise<void> {
    return this.#set.patchKeyword(keyword, false);
  }

  markRead(): Promise<void> {
    return this.#set.patchKeyword("$seen", true);
  }

  markUnread(): Promise<void> {
    return this.#set.patchKeyword("$seen", false);
  }

  reply(
    body: { text?: string; html?: string },
    options?: { replyAll?: boolean; cc?: FastmailAddress[]; bcc?: FastmailAddress[] },
  ): Promise<void> {
    return this.#set.reply(body, options);
  }

  createReplyDraft(
    body: { text?: string; html?: string },
    options?: { replyAll?: boolean; cc?: FastmailAddress[]; bcc?: FastmailAddress[] },
  ): Promise<FastmailSendableDraft> {
    return this.#set.createReplyDraft(body, options);
  }
}

// ---------------------------------------------------------------------------
// DraftImpl — the RPC interface exposed to the Gadget for one draft

@validateRpc()
export class FastmailDraftImpl extends RpcTarget implements FastmailSendableDraft {
  #approvalQueue: RpcStub<ApprovalQueue>;
  #account: DurableObjectStub<UserAccount>;
  #kv: DurableObjectStorage["kv"];
  #draftId: string;

  constructor(
      approvalQueue: RpcStub<ApprovalQueue>, account: DurableObjectStub<UserAccount>,
      kv: DurableObjectStorage["kv"], draftId: string) {
    super();
    this.#approvalQueue = approvalQueue;
    this.#account = account;
    this.#kv = kv;
    this.#draftId = draftId;
  }

  [Symbol.dispose]() {
    this.#approvalQueue[Symbol.dispose]();
  }

  get #context(): DraftContext {
    return { approvalQueue: this.#approvalQueue, account: this.#account, kv: this.#kv };
  }

  async getMetadata(): Promise<FastmailDraftInfo> {
    const { record, content, at } = currentDraft(this.#kv, this.#draftId);
    await this.#approvalQueue.authorizeObservation({
      title: "Read Fastmail draft",
      description: "Read a draft's addressees and subject.",
    });
    return toDraftInfo(record, content, at);
  }

  async getContent(): Promise<{ text?: string; html?: string }> {
    const { content } = currentDraft(this.#kv, this.#draftId);
    await this.#approvalQueue.authorizeObservation({
      title: "Read Fastmail draft",
      description: "Read a draft's body.",
    });
    const result: { text?: string; html?: string } = {};
    if (content.textBody !== undefined) result.text = content.textBody;
    if (content.htmlBody !== undefined) result.html = content.htmlBody;
    return result;
  }

  async update(patch: FastmailDraftPatch): Promise<void> {
    const { record, content } = currentDraft(this.#kv, this.#draftId);
    const next: DraftContent = { ...content };
    if (patch.to !== undefined) next.to = toJmapAddresses(patch.to) ?? [];
    if (patch.cc !== undefined) next.cc = toJmapAddresses(patch.cc);
    if (patch.bcc !== undefined) next.bcc = toJmapAddresses(patch.bcc);
    if (patch.subject !== undefined) next.subject = patch.subject;
    if (patch.text !== undefined) next.textBody = patch.text;
    if (patch.html === null) delete next.htmlBody;
    else if (patch.html !== undefined) next.htmlBody = patch.html;
    await stageDraftRevision(
      this.#context, record, { kind: "content", content: next, at: Date.now() }, "Edit email draft",
      describeSend(
        "Replace this draft in the Drafts folder with the content below. Nothing is sent.",
        { from: record.from, ...next }),
      AUTO_APPROVABLE_KINDS.draftUpdate);
  }

  async delete(): Promise<void> {
    const { record, content } = currentDraft(this.#kv, this.#draftId);
    await stageDraftRevision(
      this.#context, record, { kind: "deleted", at: Date.now() }, "Discard email draft",
      describeSend(
        "Permanently discard this draft from the Drafts folder without sending it.",
        { from: record.from, ...content }),
      AUTO_APPROVABLE_KINDS.draftDelete);
  }

  async send(): Promise<void> {
    const grant = await this.#account.getGrant();
    const from = requireSender(grant);
    const { record, content } = currentDraft(this.#kv, this.#draftId);
    if (content.to.length === 0 && !content.cc?.length && !content.bcc?.length) {
      throw new FastmailError("INVALID_RESOURCE", "This draft has no recipients to send it to.");
    }
    const params: SendEmailParams = { ...content, from };
    // No action kind: sending is never auto-approved.
    await stageDraftRevision(
      this.#context, record, { kind: "sent", params, at: Date.now() }, "Send email draft",
      describeSend("Send this draft, exactly as shown, from this Fastmail account. Sending can't be undone.", params),
      undefined);
  }
}
