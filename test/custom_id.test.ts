import { describe, expect, test } from "bun:test";
import "./setup.ts";
import { CUSTOM_ID_MAX, buildButtons, decodeCustomId, encodeCustomId } from "../src/lib/render/index.ts";
import { newId } from "../src/lib/prompts.ts";

describe("custom_id", () => {
  test("round-trips p:<id>:<idx> and m:<id>:<idx>", () => {
    const id = newId();
    expect(decodeCustomId(encodeCustomId("p", id, 7))).toEqual({ kind: "p", promptId: id, idx: 7 });
    expect(decodeCustomId(encodeCustomId("m", id, 24))).toEqual({ kind: "m", promptId: id, idx: 24 });
  });

  test("stays within 100 chars for generated ids and rejects longer ones", () => {
    expect(encodeCustomId("p", newId(), 24).length).toBeLessThanOrEqual(CUSTOM_ID_MAX);
    expect(() => encodeCustomId("p", "x".repeat(99), 0)).toThrow(/100/);
    expect(decodeCustomId("p:" + "x".repeat(99) + ":0")).toBeNull();
  });

  test("rejects garbage", () => {
    expect(decodeCustomId("q:abc:0")).toBeNull();
    expect(decodeCustomId("p:abc")).toBeNull();
    expect(decodeCustomId("p:ab c:1")).toBeNull();
    expect(decodeCustomId("p:abc:123")).toBeNull();
  });

  test("buildButtons packs 5 per row, disabled when asked", () => {
    const options = Array.from({ length: 12 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` }));
    const rows = buildButtons("abc", options);
    expect(rows.map((r) => r.components.length)).toEqual([5, 5, 2]);
    const first = rows[0]!.components[0] as { custom_id: string; disabled?: boolean };
    expect(first.custom_id).toBe("p:abc:0");
    const disabled = buildButtons("abc", options, true)[0]!.components[0] as { disabled?: boolean };
    expect(disabled.disabled).toBe(true);
  });
});
