# Roles and access (RBAC)

LinkedIn Console has two layers of access:

1. **Team role** (per teammate): what they can do in the app as a whole.
2. **Account grant** (per teammate × LinkedIn account): what they can do with one LinkedIn account.

Teammates log in to LinkedIn Console, never to LinkedIn. Access checks happen on the server for every request and Socket.IO subscription, so hiding a button in the UI is never the only protection.

## Team roles

| Role | Who | Can |
|---|---|---|
| `OWNER` | The first account created at setup (exactly one) | Everything. Cannot be demoted or disabled; only the owner can edit the owner |
| `ADMIN` | Team leads | Everything on every LinkedIn account (implicit `FULL`), manage teammates, audit log, webhooks, label editing |
| `MEMBER` | Everyone else | Only the LinkedIn accounts they were granted, at the granted level |

Admins and the owner do not need grants; they always see every account.

## Account grants (MEMBERs)

Levels are ordered: `READ` < `REPLY` < `FULL`. A higher level includes everything below it.

| Level | Allows |
|---|---|
| *(no grant)* | The account does not exist for them: it is hidden from lists and its URLs answer 404 |
| `READ` | Read conversations, messages and attachments, see the network/connections list, read and add internal notes, mark as read, release their own lock, get notifications |
| `REPLY` | + send messages and attachments, start new chats from Network, take a conversation lock, assign/status/labels on a conversation, force a sync, AI reply drafts, **watch** Live View (view only) |
| `FULL` | + **control** Live View (click/type in the LinkedIn browser), account settings (label, timezone, proxy, send cap, pause), restart the browser, manage who has access to this account, account alerts by email |

Extra rules:
- Disconnecting (deleting) an account needs `FULL` **and** being the account's owner or an admin.
- The member who connected an account is its owner and gets `FULL` on it. While the account is not connected yet (login, 2FA, checkpoint), its owner can always control Live View to finish logging in.
- Any logged-in teammate can connect a new LinkedIn account and create labels. Editing/deleting labels, users, webhooks and reading the audit log is admin-only.
- Pausing and the daily send cap apply to everyone, including new chats started from Network.

## Default access for new accounts and new teammates

`DEFAULT_GRANT` in `.env` decides what MEMBERs get automatically:

| Value | Effect |
|---|---|
| `NONE` (default, recommended) | Nothing. A new member sees no accounts, and a newly connected account is visible only to its owner and admins, until someone grants access |
| `READ` / `REPLY` / `FULL` | Every member gets this level on every newly connected account, and every new member gets it on all existing accounts |

Changing `DEFAULT_GRANT` affects only future accounts and teammates. Existing grants stay as they are; edit them under **Accounts → Team access**.

## Recommended setup

| Person | Role | Grants |
|---|---|---|
| You | `OWNER` | (all) |
| Team lead / ops | `ADMIN` | (all) |
| Account's real owner (the person whose LinkedIn it is) | `MEMBER` | `FULL` on their own account |
| SDR / assistant who answers messages | `MEMBER` | `REPLY` on the accounts they work |
| Manager / reviewer | `MEMBER` | `READ` |

Keep `FULL` small: it allows driving the LinkedIn browser directly (profile, settings, posts). Everything that happens is recorded in the audit log (Settings → Audit), including who opened Live View and with which mode.
