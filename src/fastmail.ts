import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  stripTrailingSlashes,
  type AccountDescription,
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
import {
  clearSimulatedKeywordsIfLatest,
  deletePendingAction,
  getCachedFolders,
  getPendingAction,
  getSimulatedKeywords,
  mergeSimulatedKeywords,
  putCachedFolders,
  setPendingAction,
  setSimulatedKeywords,
} from "./cache";
import { FastmailError } from "./errors";
import {
  downloadBlob,
  fetchAccountInfo,
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
  type RawThreadEntry,
  type SendEmailParams,
} from "./fastmail-api";
import type { JmapEmailObject, JmapMailboxObject } from "./fastmail-types";
import { FASTMAIL_RESOURCE, parseResourceUrl, SUPPORTED_RESOURCES, toResourceUrl } from "./resource";
import type {
  FastmailAddress,
  FastmailAttachment,
  FastmailFolder,
  FastmailMessage,
  FastmailSession,
  FastmailThread,
  FastmailThreadEntry,
} from "./types";
import TYPES_CODE from "./types.txt";
import type { FastmailAccountConfiguratorRpc } from "./configurator/fastmail-account-configurator-types";
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

  async getIdentity(): Promise<{ email?: string } | undefined> {
    const grant = this.ctx.storage.kv.get<StoredGrant>("grant");
    return grant ? { email: grant.identityEmail } : undefined;
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
    parseResourceUrl(url);
    const props: FastmailGatekeeperImplProps = { userObjectId: this.ctx.props.userObjectId };
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
      ui: new RpcStub(new FastmailAccountConfiguratorUI()),
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
  async resourceUrl(): Promise<string> {
    return toResourceUrl();
  }
}

// ---------------------------------------------------------------------------
// GatekeeperImpl DO — the connected account's whole mailbox, bound to one Gadget.

type FastmailGatekeeperImplProps = {
  userObjectId: string;
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
    return {
      url: toResourceUrl(),
      title: identity?.email ?? "Fastmail Mailbox",
      snippet: identity?.email
        ? `Read, organize, and send email through ${identity.email} on Fastmail.`
        : "Read, organize, and send email through this Fastmail account.",
      suggestedBindingName: "FASTMAIL",
      tsType: "FastmailSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions() {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<FastmailSession> {
    return new FastmailSessionImpl(approvalQueue.dup(), this.#userAccount(), this.ctx.storage.kv);
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
    } else if (pending.answersEmailId) {
      // Best-effort, after the record is gone: the reply has already been sent, so failing (or
      // retrying) the approval over a missing "$answered" flag would be worse than the flag.
      const grant = await this.#userAccount().getGrant();
      await updateEmails(
        grant.apiUrl, grant.apiToken, grant.accountId, grant.hasSubmission, [pending.answersEmailId],
        { "keywords/$answered": true },
      ).catch(error => logError("apply.markAnsweredFailed", error, { actionId }));
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
    if (pending?.kind !== "patch") return;
    for (const emailId of pending.emailIds) {
      clearSimulatedKeywordsIfLatest(this.ctx.storage.kv, emailId, actionId);
    }
  }

  async revertAction(_actionId: number): Promise<{ message: string; canRetry: boolean }> {
    return {
      message:
          "This change can't be reverted automatically. Move the message back or re-apply the " +
          "keyword yourself in Fastmail.",
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

function toJmapAddresses(addresses: FastmailAddress[] | undefined): SendEmailParams["to"] | undefined {
  return addresses?.map(address => ({ email: address.email, name: address.name }));
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
  const recipients = [...params.to, ...params.cc ?? [], ...params.bcc ?? []]
    .map(address => address.email).join(", ");
  try {
    await approvalQueue.submitAction(actionId, {
      title,
      description: `${title}: "${params.subject}" to ${recipients}.`,
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

  constructor(
      approvalQueue: RpcStub<ApprovalQueue>, account: DurableObjectStub<UserAccount>,
      kv: DurableObjectStorage["kv"]) {
    super();
    this.#approvalQueue = approvalQueue;
    this.#account = account;
    this.#kv = kv;
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
      return cached.map(toAgentFolder);
    }

    const grant = await this.#account.getGrant();
    const folders = await this.#call(() =>
      listMailboxes(grant.apiUrl, grant.apiToken, grant.accountId, grant.hasSubmission));
    putCachedFolders(this.#kv, folders, now);
    await this.#approvalQueue.authorizeObservation({
      title: "List Fastmail folders",
      description: "List the folders in this Fastmail mailbox.",
    });
    return folders.map(toAgentFolder);
  }

  #threadCursor(filter: { inMailbox?: string; text?: string }): Cursor<FastmailThreadEntry> {
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
    const metadata = await this.#call(() =>
      getThreadMetadata(grant.apiUrl, grant.apiToken, grant.accountId, grant.hasSubmission, threadId));
    return new FastmailThreadImpl(this.#approvalQueue.dup(), this.#account, this.#kv, metadata.messageIds);
  }

  async send(
    to: FastmailAddress[], subject: string, body: { text?: string; html?: string },
    options?: { cc?: FastmailAddress[]; bcc?: FastmailAddress[] },
  ): Promise<void> {
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

}

// ---------------------------------------------------------------------------
// ThreadImpl — the RPC interface exposed to the Gadget for one open thread

@validateRpc()
export class FastmailThreadImpl extends RpcTarget implements FastmailThread {
  #approvalQueue: RpcStub<ApprovalQueue>;
  #account: DurableObjectStub<UserAccount>;
  #kv: DurableObjectStorage["kv"];
  #messageIds: string[];

  constructor(
      approvalQueue: RpcStub<ApprovalQueue>, account: DurableObjectStub<UserAccount>,
      kv: DurableObjectStorage["kv"], messageIds: string[]) {
    super();
    this.#approvalQueue = approvalQueue;
    this.#account = account;
    this.#kv = kv;
    this.#messageIds = messageIds;
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


  async messages(): Promise<FastmailMessage[]> {
    const grant = await this.#account.getGrant();
    const emails = await this.#call(() => getMessages(
      grant.apiUrl, grant.apiToken, grant.accountId, grant.hasSubmission, this.#messageIds));
    await this.#approvalQueue.authorizeObservation({
      title: "Read Fastmail thread",
      description: `Read ${emails.length} message(s) in this thread.`,
    });
    return emails.map(email => toAgentMessage(email, getSimulatedKeywords(this.#kv, email.id)));
  }

  async reply(
    body: { text?: string; html?: string },
    options?: { replyAll?: boolean; cc?: FastmailAddress[]; bcc?: FastmailAddress[] },
  ): Promise<void> {
    const grant = await this.#account.getGrant();
    const from = requireSender(grant);
    const source = await this.#call(() => getReplySource(
      grant.apiUrl, grant.apiToken, grant.accountId, grant.hasSubmission, this.#messageIds));
    if (!source) throw new FastmailError("RESOURCE_NOT_FOUND", "This thread has no message to reply to.");

    const recipients = replyRecipients(source, from, options?.replyAll ?? false);
    const cc = [...recipients.cc, ...toJmapAddresses(options?.cc) ?? []];
    if (recipients.to.length === 0 && cc.length === 0) {
      throw new FastmailError("RESOURCE_NOT_FOUND", "Could not determine who to reply to.");
    }
    const subject = source.subject ?? "";
    const messageIds = source.messageId ?? [];
    await stageSend(this.#approvalQueue, this.#kv, {
      params: {
        from,
        to: recipients.to,
        cc: cc.length > 0 ? cc : undefined,
        bcc: toJmapAddresses(options?.bcc),
        subject: /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`,
        textBody: body.text,
        htmlBody: body.html,
        inReplyTo: messageIds.length > 0 ? messageIds : undefined,
        references: messageIds.length > 0 ? [...source.references ?? [], ...messageIds] : undefined,
      },
      answersEmailId: source.id,
    }, "Reply to email");
  }

  async readAttachment(blobId: string): Promise<ArrayBuffer> {
    const grant = await this.#account.getGrant();
    const emails = await this.#call(() => getMessages(
      grant.apiUrl, grant.apiToken, grant.accountId, grant.hasSubmission, this.#messageIds));
    const attachment = emails.flatMap(email => email.attachments ?? []).find(a => a.blobId === blobId);
    if (!attachment) {
      throw new FastmailError(
        "RESOURCE_NOT_FOUND", "That attachment does not belong to a message in this thread.");
    }
    const content = await this.#call(() => downloadBlob(
      grant.downloadUrlTemplate, grant.apiToken, grant.accountId, blobId,
      attachment.name ?? "attachment", attachment.type));
    await this.#approvalQueue.authorizeObservation({
      title: "Download Fastmail attachment",
      description: `Downloaded ${attachment.name ?? blobId} (${content.byteLength} bytes).`,
    });
    return content;
  }

  async #submitPatch(title: string, description: string, patch: Record<string, unknown>): Promise<void> {
    const actionId = nextActionId(this.#kv);
    setPendingAction(this.#kv, actionId, { kind: "patch", emailIds: this.#messageIds, patch });
    // Not cleaned up on a thrown error — see the matching comment in FastmailSessionImpl.send():
    // the overseer commits the action record before submitAction() returns, so deleting the local
    // record on a failed await could orphan a genuinely-pending, still-approvable action.
    await this.#approvalQueue.submitAction(actionId, { title, description, implementsRevert: false });
  }

  async moveToFolder(folderId: string): Promise<void> {
    await this.#submitPatch(
      "Move Fastmail thread", `Move this thread (${this.#messageIds.length} message(s)) to another folder.`,
      { mailboxIds: { [folderId]: true } });
  }

  async #patchKeyword(keyword: string, present: boolean, title: string): Promise<void> {
    const actionId = nextActionId(this.#kv);
    setPendingAction(this.#kv, actionId, {
      kind: "patch",
      emailIds: this.#messageIds,
      patch: { [`keywords/${keyword}`]: present ? true : null },
    });
    for (const emailId of this.#messageIds) {
      setSimulatedKeywords(this.#kv, emailId, actionId, { [keyword]: present });
    }
    // Neither the pending action record nor the simulated overlay is cleaned up on a thrown error —
    // see the matching comment in FastmailSessionImpl.send(): the overseer commits the action record
    // before submitAction() returns, so a failure reaching this await can mean the submission
    // actually succeeded server-side. Clearing either here could desync this session's view (or
    // orphan a still-approvable action) from what the overseer actually recorded.
    await this.#approvalQueue.submitAction(actionId, {
      title,
      description: `${present ? "Add" : "Remove"} the "${keyword}" keyword on this thread's ` +
        `${this.#messageIds.length} message(s).`,
      implementsRevert: false,
    });
  }

  async addKeyword(keyword: string): Promise<void> {
    await this.#patchKeyword(keyword, true, "Add Fastmail keyword");
  }

  async removeKeyword(keyword: string): Promise<void> {
    await this.#patchKeyword(keyword, false, "Remove Fastmail keyword");
  }

  async markRead(): Promise<void> {
    await this.#patchKeyword("$seen", true, "Mark Fastmail thread read");
  }

  async markUnread(): Promise<void> {
    await this.#patchKeyword("$seen", false, "Mark Fastmail thread unread");
  }
}
