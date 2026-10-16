import { describe, expect, test } from "bun:test";
import { freshStore } from "./setup.ts";
import type { APIChatInputApplicationCommandInteraction } from "discord-api-types/v10";
import { commandDefinitions, commandKey, handleCommand } from "../src/lib/commands/index.ts";
import { NOT_ALLOWED, NOT_INSTALLED_HERE, UNSUPPORTED_CONTEXT } from "../src/lib/commands/here.ts";
import { commandsDiffer, registerCommands, type CommandsRest } from "../src/lib/commands/register.ts";
import { settings } from "../src/lib/settings.ts";

const user = { id: "42", username: "alice", global_name: "Alice", discriminator: "0", avatar: null };
const base = { id: "i1", application_id: "a", token: "t", version: 1, app_permissions: "0", locale: "en-US", entitlements: [], attachment_size_limit: 0, type: 2 };
const data = { id: "cmd", type: 1, name: "cryer", options: [{ type: 1, name: "here", options: [] }] };

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

describe("command definitions", () => {
  test("cryer here is user- and guild-installable, Guild + BotDM contexts, ManageGuild", () => {
    const [c] = commandDefinitions;
    expect(c!.name).toBe("cryer");
    expect(c!.integration_types).toEqual([0, 1]);
    expect(c!.contexts).toEqual([0, 1]);
    expect(c!.default_member_permissions).toBe("32");
    expect(c!.options).toHaveLength(1);
    expect(c!.options![0]).toMatchObject({ type: 1, name: "here" });
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
