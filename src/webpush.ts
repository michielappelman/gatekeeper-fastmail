/**
 * Web Push message decryption (RFC 8291, `aes128gcm` content coding per RFC 8188), in the user
 * agent's role: Fastmail encrypts every push to a subscription created with `keys` (RFC 8620 §7.2),
 * and only the holder of the subscription's private key and auth secret can read it. A push that
 * decrypts was therefore sent by Fastmail for that subscription.
 */

const encoder = new TextEncoder();

/** A subscription's receiving keys: what is sent to Fastmail, and what stays in storage. */
export type WebPushKeys = {
  /** The uncompressed P-256 public key (65 bytes, leading 0x04), base64url: `keys.p256dh`. */
  p256dh: string;
  /** The 16-byte authentication secret, base64url: `keys.auth`. */
  auth: string;
  /** The private key, as a JWK including `d`. Never leaves the driver's storage. */
  privateJwk: JsonWebKey;
};

export async function generateWebPushKeys(): Promise<WebPushKeys> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey) as JsonWebKey;
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer);
  return {
    p256dh: base64UrlEncode(publicRaw),
    auth: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))),
    privateJwk: { kty: "EC", crv: "P-256", d: privateJwk.d, x: privateJwk.x, y: privateJwk.y },
  };
}

/** The largest push body accepted; JMAP pushes are small JSON objects (RFC 8030 caps them at 4096). */
export const MAX_PUSH_BYTES = 8192;

/**
 * Decrypts one `aes128gcm` push body as the subscription `keys` belongs to, throwing if it was not
 * encrypted for them. Only single-record bodies are accepted, which every push is (RFC 8291 §4).
 */
export async function decryptWebPush(body: Uint8Array, keys: WebPushKeys): Promise<Uint8Array> {
  if (body.length > MAX_PUSH_BYTES) throw new Error("Push body too large.");
  // Header (RFC 8188 §2.1): salt(16) || rs(4) || idlen(1) || keyid(idlen).
  if (body.length < 21) throw new Error("Push body too short.");
  const salt = body.subarray(0, 16);
  const recordSize = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  const idLength = body[20];
  // RFC 8291 §4: the keyid is the sender's ephemeral public key.
  if (idLength !== 65) throw new Error("Push body has no sender key.");
  const senderPublic = body.subarray(21, 21 + idLength);
  const ciphertext = body.subarray(21 + idLength);
  if (ciphertext.length < 17 || ciphertext.length > recordSize) {
    throw new Error("Push body is not a single aes128gcm record.");
  }

  const receiverPublic = base64UrlDecode(keys.p256dh);
  const privateKey = await crypto.subtle.importKey(
    "jwk", keys.privateJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const publicKey = await crypto.subtle.importKey(
    "raw", senderPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      // workers-types spell the member `$public`, the JS name for `public`, which the runtime reads.
      { name: "ECDH", public: publicKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, privateKey, 256));

  // RFC 8291 §3.4: IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0 || ua_public || as_public, 32).
  const ikm = await hkdf(
    base64UrlDecode(keys.auth), sharedSecret,
    concat(encoder.encode("WebPush: info\0"), receiverPublic, senderPublic), 32);
  // RFC 8188 §2.2-2.3: the content-encryption key and nonce, from the record's salt.
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const padded = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, ciphertext));
  // The last record ends with a 0x02 delimiter, then zero padding (RFC 8188 §2).
  let end = padded.length;
  while (end > 0 && padded[end - 1] === 0) end--;
  if (end === 0 || padded[end - 1] !== 2) throw new Error("Push body is not a final aes128gcm record.");
  return padded.subarray(0, end - 1);
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function base64UrlDecode(text: string): Uint8Array {
  const base64 = text.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(base64 + "=".repeat((4 - base64.length % 4) % 4)), c => c.charCodeAt(0));
}
