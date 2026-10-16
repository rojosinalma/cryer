import { describe, expect, test } from "bun:test";
import { TEST_CHANNEL, freshStore } from "./setup.ts";
import { resolveChannel, settings } from "../src/lib/settings.ts";

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
