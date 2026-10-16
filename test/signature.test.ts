import { describe, expect, test } from "bun:test";
import { TEST_PUBLIC_KEY, fakeDiscord, freshStore, sign, signedRequest } from "./setup.ts";
import { createApp } from "../src/app.ts";
import { verifySignature } from "../src/lib/transports/interactions.ts";

describe("Ed25519 verification", () => {
  test("accepts a valid signature over the raw body", async () => {
    const body = '{"type":1}';
    const { signature, timestamp } = await sign(body);
    expect(await verifySignature(body, signature, timestamp, TEST_PUBLIC_KEY)).toBe(true);
  });

  test("rejects a tampered body, a wrong timestamp and missing headers", async () => {
    const body = '{"type":1}';
    const { signature, timestamp } = await sign(body);
    expect(await verifySignature('{"type":2}', signature, timestamp, TEST_PUBLIC_KEY)).toBe(false);
    expect(await verifySignature(body, signature, "1", TEST_PUBLIC_KEY)).toBe(false);
    expect(await verifySignature(body, undefined, timestamp, TEST_PUBLIC_KEY)).toBe(false);
    expect(await verifySignature(body, signature, timestamp, "")).toBe(false);
  });
});

describe("POST /interactions", () => {
  test("signed PING → 200 {type:1}", async () => {
    await freshStore();
    fakeDiscord();
    const app = createApp();
    const res = await app.fetch(await signedRequest("http://x/interactions", { type: 1, id: "1", application_id: "a", token: "t", version: 1 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: 1 });
  });

  test("bad signature → 401 empty body, no auth header needed", async () => {
    const app = createApp();
    const res = await app.fetch(
      await signedRequest("http://x/interactions", { type: 1 }, (h) => (h["x-signature-ed25519"] = "00".repeat(64))),
    );
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
  });
});
