import { describe, expect, it } from "vitest";
import { base64UrlDecode, base64UrlEncode, decryptWebPush, generateWebPushKeys } from "../src/webpush";

// RFC 8291 §5: the published example message, and the user agent's keys it was encrypted for.
const RFC_BODY = (
  "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
  "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
  "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
const RFC_RECEIVER_PUBLIC =
  "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const RFC_RECEIVER_PRIVATE = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94";
const RFC_AUTH = "BTBZMqHH6r4Tts7J_aSIgg";

function rfcKeys() {
  const pub = base64UrlDecode(RFC_RECEIVER_PUBLIC);
  return {
    p256dh: RFC_RECEIVER_PUBLIC,
    auth: RFC_AUTH,
    privateJwk: {
      kty: "EC", crv: "P-256", d: RFC_RECEIVER_PRIVATE,
      x: base64UrlEncode(pub.subarray(1, 33)), y: base64UrlEncode(pub.subarray(33, 65)),
    },
  };
}

describe("decryptWebPush", () => {
  it("decrypts the RFC 8291 example", async () => {
    const plaintext = await decryptWebPush(base64UrlDecode(RFC_BODY), rfcKeys());
    expect(new TextDecoder().decode(plaintext)).toBe("When I grow up, I want to be a watermelon");
  });

  it("refuses a message encrypted for other keys", async () => {
    const other = await generateWebPushKeys();
    await expect(decryptWebPush(base64UrlDecode(RFC_BODY), { ...rfcKeys(), auth: other.auth }))
      .rejects.toThrow();
    await expect(decryptWebPush(base64UrlDecode(RFC_BODY), other)).rejects.toThrow();
  });

  it("refuses a tampered or truncated body", async () => {
    const body = base64UrlDecode(RFC_BODY);
    const tampered = body.slice();
    tampered[tampered.length - 1] ^= 1;
    await expect(decryptWebPush(tampered, rfcKeys())).rejects.toThrow();
    await expect(decryptWebPush(body.subarray(0, 40), rfcKeys())).rejects.toThrow();
    await expect(decryptWebPush(new TextEncoder().encode('{"@type":"StateChange"}'), rfcKeys()))
      .rejects.toThrow();
  });
});

describe("generateWebPushKeys", () => {
  it("produces an uncompressed P-256 key and a 16-byte auth secret", async () => {
    const keys = await generateWebPushKeys();
    const pub = base64UrlDecode(keys.p256dh);
    expect(pub.length).toBe(65);
    expect(pub[0]).toBe(4);
    expect(base64UrlDecode(keys.auth).length).toBe(16);
    expect(keys.privateJwk.d).toBeTypeOf("string");
  });
});
