import { z } from "zod";

export const publishingInput = z.object({
  platform: z.enum(["INSTAGRAM", "YOUTUBE"]).default("INSTAGRAM"),
  instagramAccountId: z.string().min(1).optional().nullable(),
  youtubeChannelId: z.string().min(1).optional().nullable(),
  mediaAssetId: z.string().min(1),
  kind: z.enum(["IMAGE", "REEL", "VIDEO", "SHORT"]),
  title: z.string().max(100).optional().nullable(),
  caption: z.string().max(5000).default(""),
  youtubePrivacy: z.enum(["PRIVATE", "UNLISTED", "PUBLIC"]).optional().nullable(),
  youtubeMadeForKids: z.boolean().optional().nullable(),
  youtubeNotifySubscribers: z.boolean().default(true),
  scheduledAt: z.string().datetime({ offset: true }).optional().nullable(),
  timezone: z.string().min(1).max(100).default("UTC"),
}).superRefine((input, ctx) => {
  if (input.platform === "INSTAGRAM" && input.caption.length > 2200) {
    ctx.addIssue({ code: "custom", path: ["caption"], message: "Instagram captions are limited to 2200 characters" });
  }
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
  if (input.platform === "INSTAGRAM" && !input.instagramAccountId) return "Instagram account is required";
  if (input.platform === "YOUTUBE") {
    if (!input.youtubeChannelId) return "YouTube channel is required";
    if (input.kind !== "VIDEO" && input.kind !== "SHORT") return "YouTube posts must be videos or Shorts";
    if (!input.title?.trim()) return "YouTube title is required";
    if (!input.youtubePrivacy) return "YouTube privacy is required";
    if (input.youtubeMadeForKids === null || input.youtubeMadeForKids === undefined) return "YouTube audience selection is required";
    if (input.scheduledAt && input.youtubePrivacy !== "PUBLIC") return "Scheduled YouTube videos must use Public privacy so YouTube can apply publishAt";
  }
  return null;
}
