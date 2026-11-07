-- Unified Login (Facebook Login for Business) accounts call
-- graph.facebook.com with a never-expiring system-user token. Mark them so
-- the Meta client picks the Facebook Graph host instead of
-- graph.instagram.com, and so the token-refresh paths skip them.
ALTER TABLE "InstagramAccount" ADD COLUMN "isUnifiedLogin" BOOLEAN NOT NULL DEFAULT false;
