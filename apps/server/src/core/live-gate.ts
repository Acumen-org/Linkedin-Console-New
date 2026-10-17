// The Live window is gated by the account's LinkedIn password when one is stored: a user must enter it to
// get a short-lived unlock before Caddy's forward_auth (/api/live/auth) lets their requests through.
export const LIVE_UNLOCK_SECONDS = 30 * 60;

export const liveUnlockKey = (userId: string, accountId: string) => `lu:liveunlock:${userId}:${accountId}`;
