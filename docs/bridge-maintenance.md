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

## People search + connection requests (the Search section)

The **Search** section searches all of LinkedIn (non-connections included) and can send connection requests, through a connected account. Unlike the inbox bridge, these two calls were written **without a real logged-in account to test against**, so verify them once before relying on the feature. They are deliberately isolated:

| File | Responsibility | Changes when LinkedIn… |
|---|---|---|
| `search.ts` | Navigates `/search/results/people/?keywords=…&page=N`, scrapes result cards from the DOM, detects the commercial-use limit | redesigns the search results page |
| `search-dom.ts` | Pure: turns scraped cards into results (name, headline, location, degree, member URN, vanity URL) | changes the text/line order inside a card |
| `sendInvite()` in `linkedin.ts` | Connection request via LinkedIn's own `normInvitations` request | changes the invite endpoint/body or `profileId` shape |

### Verify once (non-critical account, search enabled)

1. Admin → **Settings → Integrations → LinkedIn people search → On**. Connect a non-critical account and log in.
2. `./scripts/capture.sh on` (raw capture), then in the **Search** section run a query (e.g. a job title) with that account.
3. Check the results against the account's real LinkedIn search (open `/search/results/people/?keywords=…` in Live View):
   - Each result has a **name** and, where LinkedIn shows a vanity link, a working **View**; 2nd/3rd **degree** badges look right; headline/location are on the right lines (not "Connect"/"Message" chrome).
   - If names/lines are wrong or empty: adjust `scrapeCards` (the in-page scraper in `search.ts`) and/or the line filters in `search-dom.ts`; `pnpm --filter @linkedin-console/sidecar test` covers `search-dom.ts`.
   - If results are empty but Live View shows them: the results container/selector changed — fix the `waitForSelector`/`a[href*="/in/"]` logic in `scrapeCards`.
4. Send one **Connect** to a 2nd/3rd-degree person. Expect it to appear under *Sent invitations* on LinkedIn. If it fails, inspect `sendInvite()` — the `normInvitations` URL, the `invitee.*.profileId` wrapper, or the headers may have changed (a 4xx that isn't 409/422 means the shape is wrong; capture the request LinkedIn's own UI makes when you click Connect and match it).
5. Confirm the guards work: a second search/invite is **audited** (Audit log → "LinkedIn accounts"), and the daily caps (`SEARCH_CAP_PER_DAY`, `INVITE_CAP_PER_DAY`) and the admin toggle behave.
6. `./scripts/capture.sh off` and delete `captures/`.

### Observing invitations for the event feed (C1)

The [event feed](event-feed.md) reports connection requests (`invitation.sent` / `invitation.withdrawn`). The bridge **observes** the invite call Live LinkedIn makes — it never sends invites itself (that's the Search feature's `sendInvite`). The recogniser is `parseInvite` in `apps/sidecar/src/bridge/invites.ts` and is **best-effort until verified**:

1. `./scripts/capture.sh on`, then in **Live LinkedIn** send one connection request (with and without a note) and withdraw one from **My Network → Manage → Sent**.
2. In the captures, note the **invite-create** and **invite-withdraw** request URLs, methods and bodies. Adjust `INVITE_URL` and `findMemberUrn` in `invites.ts` so `parseInvite` returns the right `{action, memberUrn, note}` (unit tests: `apps/sidecar/test/invites.test.ts`).
3. Confirm one `invitation.sent` / `invitation.withdrawn` reaches the feed, attributed to the controlling teammate, and **no extra requests** appear in Live LinkedIn's network log.
4. **`pending_list` (phone-sent requests)** isn't wired yet: find the **Sent-invitations list** endpoint/shape when a teammate opens that page, parse it in `reader.ts`, and emit `invitations` with `action: 'pending_list'` (the server already handles it). Never open that page automatically.

### Safety (keep these)

- Search stays **off by default** — it's the highest-risk feature; turn it on deliberately, per workspace.
- Keep the caps conservative. Connection requests especially are heavily policed; `INVITE_CAP_PER_DAY` defaults low (20) on purpose, and invites also count against the teammate's own send limit.
- The invite goes through the same rate-limited lane as other in-page lookups (one at a time), so it can't burst.

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
| Search returns nothing (but Live View shows results) | Results container/card selector changed | `scrapeCards` in `search.ts` |
| Search results have wrong names / headline / location | Card text line order changed | `scrapeCards` + line filters in `search-dom.ts` |
| "Connect" fails with a non-409/422 error | Invite endpoint/body or `profileId` shape changed | `sendInvite()` in `linkedin.ts` |

## Rules of thumb

- Never add bulk or automated sending. Every send is a teammate's message; keep one queue per account (already enforced) and the daily caps. `SEND_MODE=human` brings back typing with human pauses if an account needs extra caution.
- Opening a thread marks it read on LinkedIn. The bridge avoids opening unread threads, except for an explicit "mark read" or a reply.
- If LinkedIn shows a checkpoint, the account becomes **Needs attention** and sending stops. Let a human solve it in Live View, then leave the account alone for a day.
