# Bridge maintenance: first real account + keeping up with LinkedIn

The bridge (`apps/sidecar/src/bridge/`) is the only part that depends on LinkedIn's web app. LinkedIn changes it without notice, so treat this file as the runbook.

| File | Responsibility | Changes when LinkedIn… |
|---|---|---|
| `extract.ts` | Recognizes conversations/messages/profiles in any JSON LinkedIn loads | renames entity fields/types |
| `reader.ts` | Interception of LinkedIn's JSON, realtime stream, history and send templates, outbound confirmation | changes realtime transport or GraphQL query names |
| `send-template.ts` | Fast sending: refills LinkedIn's learned create-message request | changes the send request (handled automatically, see below) |
| `session.ts` | Login-state heartbeat, quiet reconcile | changes cookies or login/checkpoint URLs |
| `commands.ts` | Command handlers (send, start chat, syncs, media) | changes how threads/history load |
| `actions.ts` | UI actions: send, attach, start chat, scroll lists | redesigns the composer / buttons |

## First real account (do this once, with a non-critical account)

1. Enable raw capture for pods: `./scripts/capture.sh on` (sets `CAPTURE_RAW=1` in `SIDECAR_ENV` and recreates the pods).
2. Connect the account and log in via Live View.
3. In Live View, open a few conversations and scroll the conversation list. Have someone send the account a message, with an image and a file.
4. Check the results:
   - **Inbox**: conversations, names, avatars and previews appear; new messages arrive within seconds.
   - Captures: `./scripts/capture.sh list <accountId>` shows thread URNs; `./scripts/capture.sh extract <accountId> <urn>` saves one thread's raw conversation and messages to `captures/`.
5. Send a test reply from the inbox to yourself or a colleague, with text and then with an image. Watch the status go to ✓, and check it on your phone.
6. If something's missing, copy a capture locally, turn it into an anonymized fixture in `apps/sidecar/test/`, adjust `extract.ts` until `pnpm --filter @linkedin-console/sidecar test` passes, then `./scripts/update.sh`.
7. Turn capture off again: `./scripts/capture.sh off` (also deletes the captured files; they contain private messages). Delete `captures/` when done.

## People search (the Search section)

The **Search** section has two modes, and the console **never sends connection requests itself** — auto-invite (`sendInvite`, `/api/accounts/:id/invite`) was removed because it's a top ban trigger. Connecting is always a human click via **Connect in Live**.

- **Search in Live** (no automation, no setup): opens LinkedIn's own people-search inside the account's **Live** session (`/accounts/:id/live?search=<keywords>` → the viewer navigates the real session to `/search/results/people/?keywords=…` once, when the teammate holds control — the same one-shot mechanism as `?profile=`). A human browses and connects. Nothing here needs a capture pass.
- **In-app search** (automated, **admin-gated + capped**): the console drives LinkedIn's search and lists read-only results in the console. Off by default (`searchEnabled`), `SEARCH_CAP_PER_DAY`/account, paced. It was written **without a real logged-in account to test against**, so verify it once (below) before relying on it. Deliberately isolated:

| File | Responsibility | Changes when LinkedIn… |
|---|---|---|
| `search.ts` | Collects the intercepted search JSON (and DOM-scrapes as a fallback), detects the commercial-use limit | redesigns the search results page |
| `search-dom.ts` | Pure: `parseSearchJson` walks the whole response tree + matches people by shape; `resultsFromCards` turns scraped cards into results | changes the result entity shape / card text order |

### Verify the in-app search once (non-critical account, `searchEnabled` on)

1. Admin → **Settings → Integrations → LinkedIn people search (in-app) → On**. Connect a non-critical account and log in.
2. `./scripts/capture.sh on`, then in the **Search** section run a query with that account and press **Search**.
3. Check the results against the account's real LinkedIn search (open `/search/results/people/?keywords=…` in Live View): names, 2nd/3rd **degree** badges, headline/location look right (not "Connect"/"Message" chrome). If empty but Live shows results, the response shape changed — fix `parseSearchJson`/`scrapeCards` (`pnpm --filter @linkedin-console/sidecar test` covers `search-dom.ts`).
4. Confirm the guards: a search is **audited** (`network.search`), the daily cap (`SEARCH_CAP_PER_DAY`) and the admin toggle behave, and **no Connect is ever auto-sent** (the only way to connect is the per-row **Connect in Live** link).
5. `./scripts/capture.sh off` and delete `captures/`.

### Observing invitations for the event feed (C1)

The [event feed](event-feed.md) reports connection requests (`invitation.sent` / `invitation.withdrawn`) by **observing** the invite call Live LinkedIn makes when a teammate clicks Connect — the console never sends invites itself. The recogniser is `parseInvite` in `apps/sidecar/src/bridge/invites.ts` and is **best-effort until verified on a real account** (there is no dev/sandbox account):

1. `./scripts/capture.sh on`, then in **Live LinkedIn** send one connection request (with and without a note) and withdraw one from **My Network → Manage → Sent**.
2. In the captures, note the **invite-create** and **invite-withdraw** request URLs, methods and bodies. Adjust `INVITE_URL` and `findMemberUrn` in `invites.ts` so `parseInvite` returns the right `{action, memberUrn, note}` (unit tests: `apps/sidecar/test/invites.test.ts`).
3. Confirm one `invitation.sent` / `invitation.withdrawn` reaches the feed, attributed to the controlling teammate, and **no extra requests** appear in Live LinkedIn's network log.
4. **`pending_list` (phone-sent requests)** isn't wired at the reader yet: find the **Sent-invitations list** endpoint/shape when a teammate opens that page, parse it in `reader.ts`, and emit `invitations` with `action: 'pending_list'` (the server already records it **and** emits `invitation.sent` with `source: 'sent_list'`). Never open that page automatically.

Because this is pure observation, a missed invite is acceptable (the feed is a fast path, not the source of truth) — verifying it just makes the capture more reliable; it never risks the account.

## Self-healing

With `HEAL_PROVIDER` set, a broken composer, Send or profile-Message selector doesn't fail right away. The bridge sends the page's accessibility snapshot to the model, which picks the element by ARIA role and name. The result is cached in Redis (`li:heal:<key>`, 30 days, shared by all accounts) and logged as `[heal] learned …`.
- When you see `[heal] learned` in `docker logs pod-<id>-sidecar`, update the matching selector in `actions.ts` so the model isn't needed.
- To forget a learned fix: `docker compose exec redis valkey-cli DEL li:heal:send`
- Self-healing only covers *finding* UI elements. Changes in LinkedIn's data shapes still need `extract.ts` updates.

## Symptoms → where to look

| Symptom | Likely cause | Fix in |
|---|---|---|
| Account stays "Needs login" after logging in | Cookie name or login URL changed | `check()` in `session.ts` |
| No conversations appear | Conversation entity shape changed | `extract.ts`: `mapConversation` / type regexes |
| New messages only appear after minutes | Realtime transport changed (SSE ↔ WebSocket) | realtime section in `reader.ts` |
| Sends fail with "Send button never became enabled" / composer timeout | Composer markup changed | `composer()` / `sendButton()` in `actions.ts` |
| Sent message stays "sending" then fails "Could not confirm" | Outbound echo not recognized | `waitForOutbound` in `reader.ts`, `fromSelf` in `extract.ts` |
| "Fetch older history" does nothing | GraphQL query name changed | `rememberTemplate()` in `reader.ts` |
| Text replies take a few seconds instead of under a second | No send template (first send of the account, or LinkedIn rejected the old one; the log says `learned the send request` once it's back) | Usually nothing: the next UI send re-learns it. If it never comes back, check `isCreateMessageRequest` in `send-template.ts` |
| Connections page empty | Connections page now server-rendered | DOM fallback in `loadConnections()` |
| In-app search returns nothing / wrong rows (but Live shows results) | Search response shape or card markup changed | `parseSearchJson` / `scrapeCards` in `search-dom.ts`, collection in `search.ts` |
| "Search in Live" opens Live but not the search | `?search=` not forwarded or the viewer navigate changed | `maybeGoto()` in `apps/sidecar/public/index.html`, `liveQuery` in `LivePage.tsx` |
| A connection request made in Live isn't tracked | Invite endpoint/body shape changed | `INVITE_URL` / `findMemberUrn` in `invites.ts` (observer only) |

## Rules of thumb

- Never add bulk or automated sending. Every send is a teammate's message; keep one queue per account (already enforced) and the daily caps. `SEND_MODE=human` brings back typing with human pauses if an account needs extra caution.
- Opening a thread marks it read on LinkedIn. The bridge avoids opening unread threads, except for an explicit "mark read" or a reply.
- If LinkedIn shows a checkpoint, the account becomes **Needs attention** and sending stops. Let a human solve it in Live View, then leave the account alone for a day.
