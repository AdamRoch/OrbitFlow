/** Browser-safe message vocabulary shared by the bus and monitoring filters. */
export const MESSAGE_TYPES = [
  "output",
  "feedback",
  "question",
  "answer",
  "channel_inbound",
  "channel_outbound",
  "cron_tick",
  "system",
] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number];
