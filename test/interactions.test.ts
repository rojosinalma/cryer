import { describe, expect, test } from "bun:test";
import { fakeDiscord, freshStore } from "./setup.ts";
import type { APIInteraction } from "discord-api-types/v10";
import { createPrompt, getPrompt } from "../src/lib/prompts.ts";
import { handleInteraction, modalValues } from "../src/lib/transports/interactions.ts";

const user = { id: "42", username: "alice", global_name: "Alice", discriminator: "0", avatar: null };
const base = { id: "i1", application_id: "a", token: "t", version: 1, app_permissions: "0", locale: "en-US", entitlements: [], authorizing_integration_owners: {}, attachment_size_limit: 0 };

const button = (customId: string): APIInteraction =>
  ({
    ...base,
    type: 3,
    channel_id: "c",
    channel: { id: "c", type: 0 },
    member: { user, roles: [], joined_at: "", deaf: false, mute: false, flags: 0, permissions: "0" },
    data: { component_type: 2, custom_id: customId },
    message: { id: "msg1", embeds: [{ title: "Deploy?", description: "body" }] },
  }) as unknown as APIInteraction;

const modal = (customId: string, values: Record<string, string>): APIInteraction =>
  ({
    ...base,
    type: 5,
    user,
    data: {
      custom_id: customId,
      components: Object.entries(values).map(([id, value]) => ({ type: 1, components: [{ type: 4, custom_id: id, value }] })),
    },
  }) as unknown as APIInteraction;

const options = [
  { id: "go", label: "Go" },
  { id: "other", label: "Other…", modal: { title: "Say more", fields: [{ id: "reason", label: "Reason", style: "paragraph" as const }] } },
];

describe("interaction handler", () => {
  test("PING → PONG", async () => {
    expect(await handleInteraction({ ...base, type: 1 } as unknown as APIInteraction)).toEqual({ type: 1 });
  });

  test("button click answers the prompt and returns UPDATE_MESSAGE with disabled buttons", async () => {
    await freshStore();
    fakeDiscord();
    const r = await createPrompt({ title: "Deploy?", source: "agent", level: "info", options });
    const res = (await handleInteraction(button(`p:${r.id}:0`))) as { type: number; data: { embeds: { fields: { value: string }[] }[]; components: { components: { disabled: boolean }[] }[] } };
    expect(res.type).toBe(7);
    expect(res.data.embeds[0]!.fields.at(-1)!.value).toMatch(/✅ Go — Alice at/);
    expect(res.data.components.flatMap((r) => r.components).every((c) => c.disabled)).toBe(true);
    expect((await getPrompt(r.id))?.status).toBe("answered");
    const { getAnswer } = await import("../src/lib/prompts.ts");
    expect((await getAnswer(r.id))?.via).toBe("button");

    const again = (await handleInteraction(button(`p:${r.id}:0`))) as { type: number; data: { content: string; flags: number } };
    expect(again.type).toBe(4);
    expect(again.data.flags).toBe(64);
    expect(again.data.content).toContain("already answered");
  });

  test("option with modal → MODAL response; submit records the text", async () => {
    await freshStore();
    fakeDiscord();
    const r = await createPrompt({ title: "Deploy?", source: "agent", level: "info", options });
    const m = (await handleInteraction(button(`p:${r.id}:1`))) as { type: number; data: { custom_id: string; title: string; components: unknown[] } };
    expect(m.type).toBe(9);
    expect(m.data.custom_id).toBe(`m:${r.id}:1`);
    expect(m.data.title).toBe("Say more");
    expect(m.data.components).toHaveLength(1);
    expect((await getPrompt(r.id))?.status).toBe("pending");

    const submit = (await handleInteraction(modal(`m:${r.id}:1`, { reason: "because" }))) as { type: number };
    expect(submit.type).toBe(7);
    const p = await getPrompt(r.id);
    expect(p?.status).toBe("answered");
    const { getAnswer } = await import("../src/lib/prompts.ts");
    expect(await getAnswer(r.id)).toMatchObject({ choice_id: "other", text: "because", user_id: "42", via: "modal" });
  });

  test("garbage custom_id and unknown prompt are ephemeral errors", async () => {
    await freshStore();
    fakeDiscord();
    const bad = (await handleInteraction(button("zzz"))) as { type: number; data: { flags: number } };
    expect(bad.type).toBe(4);
    expect(bad.data.flags).toBe(64);
    const missing = (await handleInteraction(button("p:doesnotexist:0"))) as { type: number; data: { content: string } };
    expect(missing.data.content).toContain("no longer exists");
  });

  test("modalValues handles action rows and label wrappers", () => {
    const i = {
      data: {
        components: [
          { type: 1, components: [{ type: 4, custom_id: "a", value: "1" }] },
          { type: 18, component: { type: 4, custom_id: "b", value: "2" } },
        ],
      },
    } as never;
    expect(modalValues(i)).toEqual({ a: "1", b: "2" });
  });
});
