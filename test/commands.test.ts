import { describe, expect, test } from "bun:test";
import { freshStore } from "./setup.ts";
import type { APIChatInputApplicationCommandInteraction } from "discord-api-types/v10";
import { commandDefinitions, commandKey, handleCommand } from "../src/lib/commands/index.ts";
import { NOT_ALLOWED, NOT_INSTALLED_HERE, UNSUPPORTED_CONTEXT } from "../src/lib/commands/here.ts";
import { describeTarget, ROUTE_LINES } from "../src/lib/commands/status.ts";
import { commandsDiffer, registerCommands, type CommandsRest } from "../src/lib/commands/register.ts";
import { env } from "../src/lib/env.ts";
import { settings } from "../src/lib/settings.ts";
import { version } from "../src/version.ts";

const user = { id: "42", username: "alice", global_name: "Alice", discriminator: "0", avatar: null };
const base = { id: "i1", application_id: "a", token: "t", version: 1, app_permissions: "0", locale: "en-US", entitlements: [], attachment_size_limit: 0, type: 2 };
const data = { id: "cmd", type: 1, name: "cryer", options: [{ type: 1, name: "here", options: [] }] };
const sub = (i: APIChatInputApplicationCommandInteraction, name: string): APIChatInputApplicationCommandInteraction =>
  ({ ...i, data: { ...data, options: [{ type: 1, name, options: [] }] } }) as unknown as APIChatInputApplicationCommandInteraction;

const dm = (): APIChatInputApplicationCommandInteraction =>
  ({ ...base, data, context: 1, user, channel_id: "dm-chan", authorizing_integration_owners: { "1": "42" } }) as unknown as APIChatInputApplicationCommandInteraction;

const guild = (owners: Record<string, string>): APIChatInputApplicationCommandInteraction =>
  ({
    ...base,
    data,
    context: 0,
    guild_id: "g1",
    channel_id: "chan-9",
    member: { user, roles: [], joined_at: "", deaf: false, mute: false, flags: 0, permissions: "0" },
    authorizing_integration_owners: owners,
  }) as unknown as APIChatInputApplicationCommandInteraction;

type Eph = { type: number; data: { content: string; flags: number } };

describe("/cryer here", () => {
  test("BOT_DM → default_channel = dm:<user>", async () => {
    await freshStore();
    const res = (await handleCommand(dm())) as Eph;
    expect(res.type).toBe(4);
    expect(res.data.flags).toBe(64);
    expect(res.data.content).toContain("`dm:42`");
    expect(await settings.get("default_channel")).toBe("dm:42");
  });

  test("guild with server install (owner \"0\") → channel id, mentions route.* overrides", async () => {
    await freshStore();
    const res = (await handleCommand(guild({ "0": "g1" }))) as Eph;
    expect(res.data.content).toContain("`chan-9`");
    expect(res.data.content).toContain("route.*");
    expect(await settings.get("default_channel")).toBe("chan-9");
  });

  test("guild without server install → refusal, setting untouched", async () => {
    await freshStore();
    const before = await settings.get("default_channel");
    const res = (await handleCommand(guild({ "1": "42" }))) as Eph;
    expect(res.data.content).toBe(NOT_INSTALLED_HERE);
    expect(res.data.flags).toBe(64);
    expect(await settings.get("default_channel")).toBe(before);
  });

  test("PRIVATE_CHANNEL context → refusal", async () => {
    await freshStore();
    const i = { ...dm(), context: 2 } as APIChatInputApplicationCommandInteraction;
    expect(((await handleCommand(i)) as Eph).data.content).toBe(UNSUPPORTED_CONTEXT);
  });

  test("command_users gate: listed user passes, others are refused", async () => {
    await freshStore();
    await settings.set("command_users", "7, 42");
    expect(((await handleCommand(dm())) as Eph).data.content).toContain("`dm:42`");
    await settings.set("command_users", "7");
    const res = (await handleCommand(dm())) as Eph;
    expect(res.data.content).toBe(NOT_ALLOWED);
    expect(await settings.get("default_channel")).toBe("dm:42");
  });

  test("unknown command / subcommand → ephemeral, non-chat-input → ephemeral", async () => {
    await freshStore();
    const other = { ...dm(), data: { ...data, name: "nope", options: [] } } as unknown as APIChatInputApplicationCommandInteraction;
    expect(commandKey(other)).toBe("nope");
    expect(((await handleCommand(other)) as Eph).data.content).toContain("Unknown command");
    const menu = { ...dm(), data: { ...data, type: 2 } } as unknown as APIChatInputApplicationCommandInteraction;
    expect(((await handleCommand(menu)) as Eph).data.content).toContain("kind of command");
  });
});

describe("/cryer status", () => {
  test("renders version, channel target, routes and gateway keys", async () => {
    await freshStore();
    await settings.set("default_channel", "123456789012345678");
    await settings.set("route.dagu.failure", "dm:42");
    await settings.set("route.apprise.*", "555");
    const res = (await handleCommand(sub(dm(), "status"))) as Eph;
    expect(res.type).toBe(4);
    expect(res.data.flags).toBe(64);
    const c = res.data.content;
    expect(c).toContain(`cryer ${version}`);
    expect(c).toContain("Default target: channel <#123456789012345678>");
    expect(c).toContain("Routes (2):");
    expect(c).toContain("`route.dagu.failure` → your DM (`dm:42`)");
    expect(c).toContain("`route.apprise.*` → channel <#555>");
    expect(c).toMatch(/Gateway: (disabled|leader|follower)/);
    expect(c).toContain("connected: ");
    expect(c).toContain("reply parsing: ");
    expect(c).toContain("in DMs: ");
    expect(await settings.get("default_channel")).toBe("123456789012345678");
  });

  test("no default → unset, no routes → none; dm: target of the invoker → your DM", async () => {
    await freshStore();
    await settings.set("default_channel", "");
    const a = (await handleCommand(sub(guild({ "0": "g1" }), "status"))) as Eph;
    expect(a.data.content).toContain("Default target: unset");
    expect(a.data.content).toContain("Routes: none");
    await settings.set("default_channel", "dm:42");
    const b = (await handleCommand(sub(dm(), "status"))) as Eph;
    expect(b.data.content).toContain("Default target: your DM (`dm:42`)");
  });

  test("describeTarget: other user's DM, snowflake, unset, odd value; route lines capped", async () => {
    expect(describeTarget("dm:7", "42")).toBe("DM of user <@7> (`dm:7`)");
    expect(describeTarget("dm:7", undefined)).toBe("DM of user <@7> (`dm:7`)");
    expect(describeTarget("99", "42")).toBe("channel <#99>");
    expect(describeTarget("", "42")).toBe("unset");
    expect(describeTarget("weird", "42")).toBe("`weird`");
    await freshStore();
    for (let n = 0; n < ROUTE_LINES + 3; n++) await settings.set(`route.s${n}.*`, "1");
    const res = (await handleCommand(sub(dm(), "status"))) as Eph;
    expect(res.data.content).toContain(`Routes (${ROUTE_LINES + 3}):`);
    expect(res.data.content).toContain("… and 3 more");
    expect(res.data.content.split("\n").filter((l) => l.startsWith("• ")).length).toBe(ROUTE_LINES + 1);
  });

  test("honours command_users", async () => {
    await freshStore();
    await settings.set("command_users", "7");
    expect(((await handleCommand(sub(dm(), "status"))) as Eph).data.content).toBe(NOT_ALLOWED);
    await settings.set("command_users", "7,42");
    expect(((await handleCommand(sub(dm(), "status"))) as Eph).data.content).toContain("Default target:");
  });
});

describe("/cryer forget", () => {
  test("resets default_channel to the env fallback", async () => {
    await freshStore();
    await settings.set("default_channel", "dm:42");
    const res = (await handleCommand(sub(dm(), "forget"))) as Eph;
    expect(res.type).toBe(4);
    expect(res.data.flags).toBe(64);
    expect(res.data.content).toContain(`Default target reset to \`${env.defaultChannelId}\`.`);
    expect(res.data.content).toContain("/cryer here");
    expect(await settings.get("default_channel")).toBe(env.defaultChannelId);
  });

  test("resets to \"\" (unset) when the env fallback is empty", async () => {
    await freshStore();
    await settings.set("default_channel", "chan-9");
    const saved = env.defaultChannelId;
    (env as { defaultChannelId: string }).defaultChannelId = "";
    try {
      const res = (await handleCommand(sub(guild({ "0": "g1" }), "forget"))) as Eph;
      expect(res.data.content).toContain("Default target reset to unset.");
      expect(res.data.content).toContain("will fail until /cryer here is run again");
      expect(await settings.get("default_channel")).toBe("");
    } finally {
      (env as { defaultChannelId: string }).defaultChannelId = saved;
    }
  });

  test("honours command_users, setting untouched when refused", async () => {
    await freshStore();
    await settings.set("default_channel", "dm:42");
    await settings.set("command_users", "7");
    expect(((await handleCommand(sub(dm(), "forget"))) as Eph).data.content).toBe(NOT_ALLOWED);
    expect(await settings.get("default_channel")).toBe("dm:42");
  });
});

describe("command definitions", () => {
  test("cryer is user- and guild-installable, Guild + BotDM contexts, ManageGuild, three subcommands", () => {
    const [c] = commandDefinitions;
    expect(commandDefinitions).toHaveLength(1);
    expect(c!.name).toBe("cryer");
    expect(c!.integration_types).toEqual([0, 1]);
    expect(c!.contexts).toEqual([0, 1]);
    expect(c!.default_member_permissions).toBe("32");
    expect(c!.options).toHaveLength(3);
    expect(c!.options!.map((o) => o.name)).toEqual(["here", "status", "forget"]);
    for (const o of c!.options!) expect(o).toMatchObject({ type: 1 });
  });
});

describe("registerCommands", () => {
  // What Discord returns: our fields plus ids/versions, arrays possibly in another order, nulls for unset.
  const liveMatch = () =>
    commandDefinitions.map((c) => ({
      ...c,
      id: "1",
      application_id: "a",
      version: "2",
      type: 1,
      nsfw: false,
      default_permission: true,
      integration_types: [...c.integration_types!].reverse(),
      contexts: [...c.contexts!].reverse(),
      options: c.options!.map((o) => ({ ...o, options: [] })),
    }));

  test("commandsDiffer: equal sets (reordered arrays, extra live fields) do not differ", () => {
    expect(commandsDiffer(liveMatch(), commandDefinitions)).toBe(false);
  });

  test("commandsDiffer: changed description / contexts / permissions / membership differ", () => {
    const l = liveMatch();
    expect(commandsDiffer([{ ...l[0]!, description: "x" }], commandDefinitions)).toBe(true);
    expect(commandsDiffer([{ ...l[0]!, contexts: [0] }], commandDefinitions)).toBe(true);
    expect(commandsDiffer([{ ...l[0]!, default_member_permissions: null }], commandDefinitions)).toBe(true);
    expect(commandsDiffer([{ ...l[0]!, options: [] }], commandDefinitions)).toBe(true);
    expect(commandsDiffer([], commandDefinitions)).toBe(true);
    expect(commandsDiffer([...l, { name: "stale", description: "old" }], commandDefinitions)).toBe(true);
  });

  test("commandsDiffer: a live set with only `here` differs from the wanted three (canonical keeps all subcommands)", () => {
    const l = liveMatch();
    const onlyHere = { ...l[0]!, options: l[0]!.options!.filter((o) => o.name === "here") };
    expect(commandsDiffer([onlyHere], commandDefinitions)).toBe(true);
    const reordered = { ...l[0]!, options: [...l[0]!.options!].reverse() };
    expect(commandsDiffer([reordered], commandDefinitions)).toBe(true); // option order is part of the contract
  });

  const fakeRest = (live: unknown[]) => {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const rest: CommandsRest = {
      async get(path) {
        calls.push({ method: "GET", path });
        return live;
      },
      async put(path, body) {
        calls.push({ method: "PUT", path, body });
        return body;
      },
    };
    return { rest, calls };
  };

  test("live set differs → PUT full set once; identical → no PUT", async () => {
    await freshStore();
    const a = fakeRest([]);
    expect(await registerCommands(a.rest)).toBe("registered");
    expect(a.calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
    expect(a.calls[1]!.path).toBe("/applications/222222222222222222/commands");
    expect(a.calls[1]!.body).toEqual(commandDefinitions);

    const b = fakeRest(liveMatch());
    expect(await registerCommands(b.rest)).toBe("up-to-date");
    expect(b.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  test("commands_register=false → skipped without any REST call", async () => {
    await freshStore();
    await settings.set("commands_register", "false");
    const a = fakeRest([]);
    expect(await registerCommands(a.rest)).toBe("skipped");
    expect(a.calls).toHaveLength(0);
  });
});
