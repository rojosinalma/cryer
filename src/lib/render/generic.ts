import { EmbedBuilder } from "@discordjs/builders";
import { LEVEL_COLORS } from "../types.ts";
import type { Renderer } from "./types.ts";

export const generic: Renderer = {
  embed(input) {
    const e = new EmbedBuilder()
      .setTitle(input.title.slice(0, 256))
      .setColor(LEVEL_COLORS[input.level])
      .setTimestamp(new Date(input.createdAt))
      .setFooter({ text: `${input.source} · ${input.level}` });
    if (input.body) e.setDescription(input.body.slice(0, 4096));
    if (input.url) e.setURL(input.url);
    if (input.fields?.length) {
      e.addFields(
        input.fields.slice(0, 25).map((f) => ({
          name: f.name.slice(0, 256),
          value: f.value.slice(0, 1024),
          inline: f.inline ?? false,
        })),
      );
    }
    return e.toJSON();
  },
};
