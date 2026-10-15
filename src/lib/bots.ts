import type { BotProfile } from "./types";

/** Returns `base`, or `base 2`, `base 3`… so it never collides with an existing bot name or slug. */
export function uniqueBotName(base: string, bots: BotProfile[]): string {
  const taken = (name: string) => bots.some(bot => bot.name.toLowerCase() === name.toLowerCase() || bot.slug.toLowerCase() === name.toLowerCase());
  let name = base;
  for (let suffix = 2; taken(name); suffix++) name = `${base} ${suffix}`;
  return name;
}

/** A copy keeps the bot's settings but starts with fresh memory; the backend assigns the id and slug. */
export function duplicateBot(bot: BotProfile, bots: BotProfile[]): BotProfile {
  return {
    ...bot,
    id: "",
    slug: "",
    name: uniqueBotName(`${bot.name} (copy)`, bots),
    isPrimary: false,
    archived: false,
    memories: [],
    autoCreatedForCli: false,
  };
}
