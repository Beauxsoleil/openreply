# YouTube video and Shorts scheduling

OpenReply uses the existing media library, calendar, publishing queue, leases,
and attempt history for both Instagram and YouTube. Instagram publishing and DM
automation attachment remain isolated: YouTube posts cannot select a DM campaign.

## Google setup

1. Create or select a Google Cloud project and enable **YouTube Data API v3**.
2. Configure the OAuth consent screen. Apps outside testing may need Google
   verification for the `youtube.upload` scope.
3. Create an OAuth 2.0 **Web application** client.
4. Add `<NEXTAUTH_URL>/api/youtube/callback` as an exact authorized redirect URI.
5. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in the web app and publishing
   worker environments. Keep the existing `ENCRYPTION_KEY` identical in both.

The connect flow requests offline access. Access and refresh tokens are AES-256-GCM
encrypted before storage; refresh tokens are never returned to the browser or logs.

## Scheduling lifecycle

- The browser uploads media once to the private R2-backed shared media library.
- Scheduling queues YouTube immediately. The worker starts a resumable upload in
  8 MiB chunks and stores only the resumable session URL if interrupted.
- Scheduled videos are created private with YouTube's native `status.publishAt`.
  The requested release privacy must therefore be Public.
- The reconciler polls YouTube status. Rejected uploads become `FAILED`; a public
  video becomes `PUBLISHED`. No second upload is attempted after a video id exists.
- Shorts use the same API upload path. YouTube classifies qualifying vertical,
  short-duration uploads as Shorts; the API does not expose a separate Shorts type.

## Validation gates

- Apply migration `20261108210000_add_youtube_scheduling`.
- Configure R2, Redis, the publishing worker, and Google OAuth variables.
- Connect a real channel and run a private test upload before enabling production
  scheduling. API quota and OAuth consent-screen status can block real uploads.
