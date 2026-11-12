# External event feed

Outreach events (connection requests, acceptances, outgoing messages) for an outside system (n8n, a CRM, a dashboard). Two ways to consume, meant to be used together:

- **Signed webhooks** — low latency, pushed to your endpoint. May be dropped while an endpoint is down (a 2-minute circuit breaker), so treat them as a fast path, not the source of truth.
- **The read-only feed** (`/api/ext/v1`) — a replayable, append-only log you poll by cursor to catch up on anything the webhooks missed. 90-day retention.

## Authentication

An **admin** creates a key in **Settings → Integrations → External API keys**. The key is shown **once** — store it safely.

```
Authorization: Bearer <key>
```

The key works **only** on `/api/ext/v1/*` (it can't reach any other route and isn't a user session). Every key's use is recorded (`last_used_at` + an audit entry); revoke a key any time in the same screen.

## Routes (GET only)

| Route | Returns |
|---|---|
| `/api/ext/v1/events?after=<seq>&limit=<n≤500>` | `{ events: [...], nextCursor }` — events in `seq` order after the cursor |
| `/api/ext/v1/invitations?status=pending\|accepted\|withdrawn` | `{ invitations: [...] }` (default `pending`) |
| `/api/ext/v1/accounts` | `{ accounts: [{ id, name, invitesLast7Days, inviteWeeklyLimit }] }` |

## Event envelope

Every event carries the same identity, so you can key on the LinkedIn profile and the teammate:

```jsonc
{
  "seq": 1234,
  "type": "invitation.sent",
  "at": "2026-11-13T09:00:00.000Z",
  "person":  { "memberUrn": "urn:li:fsd_profile:ACoAA…", "publicId": "jane-doe",
               "profileUrl": "https://www.linkedin.com/in/jane-doe/", "name": "Jane Doe" },
  "account": { "id": "ab12cd34ef56", "name": "Acme Sales" },
  "user":    { "email": "rep@acme.com", "name": "A Rep" }   // null when the actor is unknown
  // …plus per-type fields below
}
```

- Identify a **person** by `profileUrl` (the vanity link); `publicId` may be `null` when LinkedIn hasn't exposed it yet — don't block on it.
- Identify a **teammate** by `email`. Several teammates share one account, so never infer the teammate from the account.

### Event types

| `type` | Extra fields | When |
|---|---|---|
| `invitation.sent` | `note`, `source` (`live_view`) | A teammate sent a connection request in Live LinkedIn |
| `invitation.withdrawn` | — | A request was withdrawn |
| `connection.accepted` | `invitedByUs` (bool) | A new connection appeared; `invitedByUs` = it matched a request we sent |
| `message.sent` | `conversationId` | Any outgoing message (inbox, Live LinkedIn, or phone), one per message |

The same `type` values are available as **webhook** subscriptions (Settings → Webhooks), signed with HMAC-SHA256.

## Consuming

1. Subscribe a webhook for low-latency pushes (optional but recommended).
2. Poll `GET /api/ext/v1/events?after=<lastSeq>`; process each event; persist `nextCursor` as your new `<lastSeq>`. Start from `after=0`.
3. The feed is the source of truth — if a webhook is missed, the next poll returns it.

`/api/ext/v1/accounts` gives each account's `invitesLast7Days` against a soft `inviteWeeklyLimit` (set by `INVITE_WEEKLY_LIMIT`, default 80, below LinkedIn's ~100/week) for your own pacing — the console enforces nothing.

## Notes

- `invitation.*` depends on the bridge recognising LinkedIn's invite calls — verify once per real account (see [bridge-maintenance.md](bridge-maintenance.md)).
- `connection.accepted` can lag up to ~25h (it rides the daily connection sync), and never fires for the baseline of connections that existed before the account's first sync.
