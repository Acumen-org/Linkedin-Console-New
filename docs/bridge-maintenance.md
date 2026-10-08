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

## Rules of thumb

- Never add bulk or automated sending. Every send is a teammate's message; keep one queue per account (already enforced) and the daily caps. `SEND_MODE=human` brings back typing with human pauses if an account needs extra caution.
- Opening a thread marks it read on LinkedIn. The bridge avoids opening unread threads, except for an explicit "mark read" or a reply.
- If LinkedIn shows a checkpoint, the account becomes **Needs attention** and sending stops. Let a human solve it in Live View, then leave the account alone for a day.
