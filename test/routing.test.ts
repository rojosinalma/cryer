import { describe, expect, test } from "bun:test";
import { TEST_CHANNEL, fakeDiscord, freshStore } from "./setup.ts";
import { clearDmCache, dmTarget, isDmTarget, parseTarget, resolveChannel, settings, targetToChannel } from "../src/lib/settings.ts";
import { dmChannels } from "../src/db/schema.ts";
import { DiscordAPIError } from "@discordjs/rest";
import { call } from "../src/lib/discord.ts";
import { SystemError } from "../src/lib/errors.ts";
import { getDb } from "../src/lib/store.ts";

describe("routing resolution", () => {
  test("explicit > route.<source>.<level> > route.<source>.* > default_channel > env", async () => {
    const table: Record<string, string> = {
      "route.dagu.failure": "1",
      "route.dagu.*": "2",
      default_channel: "3",
    };
    const lookup = async (k: string) => table[k] ?? "";
    expect(await resolveChannel("dagu", "failure", "9", lookup)).toBe("9");
    expect(await resolveChannel("dagu", "failure", undefined, lookup)).toBe("1");
    expect(await resolveChannel("dagu", "info", undefined, lookup)).toBe("2");
    expect(await resolveChannel("apprise", "info", undefined, lookup)).toBe("3");
    expect(await resolveChannel("apprise", "info", undefined, async () => "")).toBe(TEST_CHANNEL);
  });

  test("reads the settings table through the cache", async () => {
    await freshStore();
    expect(await resolveChannel("x", "info", undefined)).toBe(TEST_CHANNEL);
    await settings.set("route.x.info", "777");
    expect(await resolveChannel("x", "info", undefined)).toBe("777");
  });
});

describe("dm targets", () => {
  test("parseTarget / isDmTarget / dmTarget", () => {
    expect(parseTarget("123")).toEqual({ kind: "channel", channelId: "123" });
    expect(parseTarget("dm:123")).toEqual({ kind: "dm", userId: "123" });
    expect(isDmTarget("dm:123")).toBe(true);
    expect(isDmTarget("123")).toBe(false);
    expect(dmTarget("123")).toBe("dm:123");
    expect(() => parseTarget("dm:abc")).toThrow(/invalid target/);
    expect(() => parseTarget("")).toThrow(/invalid target/);
  });

  test("route value dm:<user> → createDm once, then in-process cache, then the dm_channels table", async () => {
    await freshStore();
    const d = fakeDiscord();
    await settings.set("route.x.info", "dm:123");
    expect(await resolveChannel("x", "info", undefined)).toBe("dm:123");
    expect(await targetToChannel("dm:123")).toBe("dm-123");
    expect(await targetToChannel("dm:123")).toBe("dm-123");
    expect(d.dms).toEqual(["123"]);
    clearDmCache();
    expect(await targetToChannel("dm:123")).toBe("dm-123");
    expect(d.dms).toEqual(["123"]);
    expect(await getDb().select().from(dmChannels)).toMatchObject([{ userId: "123", channelId: "dm-123" }]);
    expect(await targetToChannel("456")).toBe("456");
    expect(d.dms).toEqual(["123"]);
  });

  test("a refused DM surfaces as a 502 with the reason", async () => {
    await freshStore();
    const d = fakeDiscord();
    d.refuseDm = 50278;
    const err = await targetToChannel("dm:9").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SystemError);
    expect((err as SystemError).status).toBe(502);
    expect((err as SystemError).message).toMatch(/refuses DMs to user 9 \(code 50278\)/);
    expect(await getDb().select().from(dmChannels)).toHaveLength(0);
  });
});

describe("discord call: DM refusal mapping", () => {
  test("a DiscordAPIError 50278/50007 on createDm becomes a SystemError 502 naming the user and the reason", async () => {
    const boom = (code: number) =>
      new DiscordAPIError({ code, message: "Cannot send messages to this user" }, code, 403, "POST", "/users/@me/channels", {});
    const err = await call("POST", "/users/@me/channels", async () => { throw boom(50278); }, { dmUserId: "9" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SystemError);
    expect((err as SystemError).status).toBe(502);
    expect((err as SystemError).message).toMatch(/refuses DMs to user 9 \(code 50278\): .*not installed/);
    expect((err as SystemError).data).toEqual({ code: 50278, user_id: "9" });
    const closed = await call("POST", "/x", async () => { throw boom(50007); }, { dmUserId: "9" }).catch((e: unknown) => e);
    expect((closed as SystemError).message).toMatch(/code 50007/);
    // Without a dmUserId the generic message is kept (other endpoints are untouched).
    const generic = await call("POST", "/x", async () => { throw boom(50007); }).catch((e: unknown) => e);
    expect((generic as SystemError).message).toBe("discord POST /x: 403 Cannot send messages to this user");
  });
});
