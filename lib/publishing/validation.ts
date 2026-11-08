import { z } from "zod";

export const publishingInput = z.object({
  instagramAccountId: z.string().min(1),
  mediaAssetId: z.string().min(1),
  kind: z.enum(["IMAGE", "REEL"]),
  caption: z.string().max(2200).default(""),
  scheduledAt: z.string().datetime({ offset: true }).optional().nullable(),
  timezone: z.string().min(1).max(100).default("UTC"),
});
export type PublishingInput = z.infer<typeof publishingInput>;

export function validateSchedule(input: PublishingInput, now = new Date()) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: input.timezone });
  } catch {
    return "Invalid IANA timezone";
  }
  if (input.scheduledAt) {
    const when = new Date(input.scheduledAt);
    if (Number.isNaN(when.getTime())) return "Invalid scheduled date";
    if (when.getTime() <= now.getTime() + 60_000) return "Schedule at least one minute in the future";
  }
  return null;
}
