import { describe, expect, test } from "bun:test";
import "./setup.ts";
import { rendererFor, renderers } from "../src/lib/render/index.ts";
import { LEVEL_COLORS } from "../src/lib/types.ts";

describe("render registry", () => {
  test("generic is registered and is the fallback for unknown types", () => {
    expect(Object.keys(renderers)).toContain("generic");
    expect(rendererFor("nope")).toBe(renderers.generic!);
  });

  test("generic embed: title, body, colour by level, fields, footer", () => {
    const e = rendererFor("generic").embed({
      source: "dagu",
      type: "generic",
      level: "failure",
      title: "backup failed",
      body: "disk full",
      fields: [{ name: "node", value: "node-a", inline: true }],
      url: "https://dagu.example.internal/dags/x",
      createdAt: "2026-10-11T00:00:00.000Z",
    });
    expect(e.title).toBe("backup failed");
    expect(e.description).toBe("disk full");
    expect(e.color).toBe(LEVEL_COLORS.failure);
    expect(e.fields).toEqual([{ name: "node", value: "node-a", inline: true }]);
    expect(e.footer?.text).toBe("dagu · failure");
    expect(e.url).toBe("https://dagu.example.internal/dags/x");
    expect(e.timestamp).toBe("2026-10-11T00:00:00.000Z");
  });
});
