CREATE TYPE "PublishPlatform" AS ENUM ('INSTAGRAM', 'YOUTUBE');
CREATE TYPE "YouTubePrivacy" AS ENUM ('PRIVATE', 'UNLISTED', 'PUBLIC');

ALTER TYPE "PublishKind" ADD VALUE 'VIDEO';
ALTER TYPE "PublishKind" ADD VALUE 'SHORT';

CREATE TABLE "YouTubeChannel" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "thumbnailUrl" TEXT,
  "accessToken" TEXT NOT NULL,
  "refreshToken" TEXT NOT NULL,
  "tokenExpiresAt" TIMESTAMP(3) NOT NULL,
  "scope" TEXT NOT NULL,
  "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "YouTubeChannel_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ScheduledPost"
  ADD COLUMN "platform" "PublishPlatform" NOT NULL DEFAULT 'INSTAGRAM',
  ADD COLUMN "youtubeChannelId" TEXT,
  ADD COLUMN "title" TEXT,
  ADD COLUMN "youtubeVideoId" TEXT,
  ADD COLUMN "youtubeUploadUrl" TEXT,
  ADD COLUMN "youtubePrivacy" "YouTubePrivacy",
  ADD COLUMN "youtubeMadeForKids" BOOLEAN,
  ADD COLUMN "youtubeNotifySubscribers" BOOLEAN NOT NULL DEFAULT true,
  ALTER COLUMN "instagramAccountId" DROP NOT NULL;

CREATE UNIQUE INDEX "YouTubeChannel_channelId_key" ON "YouTubeChannel"("channelId");
CREATE INDEX "YouTubeChannel_workspaceId_idx" ON "YouTubeChannel"("workspaceId");
CREATE INDEX "ScheduledPost_youtubeChannelId_scheduledAt_idx" ON "ScheduledPost"("youtubeChannelId", "scheduledAt");

ALTER TABLE "YouTubeChannel" ADD CONSTRAINT "YouTubeChannel_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScheduledPost" ADD CONSTRAINT "ScheduledPost_youtubeChannelId_fkey"
  FOREIGN KEY ("youtubeChannelId") REFERENCES "YouTubeChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
