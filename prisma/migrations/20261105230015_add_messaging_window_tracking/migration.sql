-- AlterEnum
ALTER TYPE "DmStatus" ADD VALUE 'SKIPPED_WINDOW_CLOSED';

-- CreateTable
CREATE TABLE "RecipientInteraction" (
    "id" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "lastInteractionAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecipientInteraction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecipientInteraction_instagramAccountId_idx" ON "RecipientInteraction"("instagramAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "RecipientInteraction_instagramAccountId_recipientId_key" ON "RecipientInteraction"("instagramAccountId", "recipientId");

-- AddForeignKey
ALTER TABLE "RecipientInteraction" ADD CONSTRAINT "RecipientInteraction_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
