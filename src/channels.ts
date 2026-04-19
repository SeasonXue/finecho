import type { ChannelConfig } from "./types.ts";

export const CHANNELS: ChannelConfig[] = [
  {
    slug: "yutinghaofinance",
    name: "游庭皓的財經皓角",
    url: "https://www.youtube.com/@yutinghaofinance/streams",
  },
];

export function getChannel(slug?: string): ChannelConfig {
  if (!slug) {
    const first = CHANNELS[0];
    if (!first) throw new Error("No channels configured");
    return first;
  }
  const found = CHANNELS.find((c) => c.slug === slug);
  if (!found) throw new Error(`Unknown channel: ${slug}`);
  return found;
}
