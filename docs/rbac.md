# Roles and access (RBAC)

LinkedIn Console has two layers of access:

1. **Team role** (per teammate): what they can do in the app as a whole.
2. **Account grant** (per teammate × LinkedIn account): what they can do with one LinkedIn account.

Teammates log in to LinkedIn Console, never to LinkedIn. Access checks happen on the server for every request and Socket.IO subscription, so hiding a button in the UI is never the only protection.

## Signing in

| Setup | How teammates sign in |
|---|---|
| Default | Email + password (10+ characters), 10 failed attempts per IP lock it for 15 minutes |
| Microsoft 365 (`MICROSOFT_*`) | “Sign in with Microsoft” with their company account: the company's MFA and conditional access apply. Only people already added here get in; the first sign-in links the Microsoft account (Entra object ID), later ones must use the same account |
| `PASSWORD_SIGNIN=owner` | Passwords only for the owner (emergency access if Microsoft is unavailable); everyone else must use Microsoft |

### Following the Twilio console staff list

With `STAFF_SYNC` the app reads the Twilio console's staff list every few minutes (`TWILIO_CONSOLE_URL`, `TWILIO_CONSOLE_API_KEY` = its server API key):

- Teammates are linked to their staff record by email or email alias.
- **Leavers**: anyone resigned or archived there is disabled here and signed out everywhere within one sync. If that is undone there, they are re-enabled (only those the sync disabled; someone an admin disabled stays disabled).
- `STAFF_SYNC=provision` also adds active staff as **members with no account access** (Microsoft sign-in only). Admins still decide roles and which LinkedIn accounts each person can use; roles are never copied from the Twilio console.
- The owner is never changed. A failed or empty list changes nothing, and a run that would disable more than a quarter of the linked team at once is refused (Team page shows the error).
- Team page shows the sign-in setup, the last sync result and a **Sync now** button. Every change is in the audit log as done by *System*.

## Team roles

| Role | Who | Can |
|---|---|---|
| `OWNER` | Exactly one (database rule): the first account created at setup, or whoever ownership was handed to | Everything. Cannot be demoted or disabled; only the owner can edit the owner. Keeps password sign-in with `PASSWORD_SIGNIN=owner` |
| `ADMIN` | Team leads | Everything on every LinkedIn account (implicit `FULL`), connect LinkedIn accounts, assign staff, manage the team, audit log, webhooks, label editing |
| `MEMBER` (shown as **Staff**) | Everyone who works the inbox | Only the LinkedIn accounts an admin assigned them, at the assigned level. Every message they send is recorded with their name |
| `AUDITOR` | Compliance | Reads and exports the audit log; no inbox, no accounts |

Admins and the owner do not need grants; they always see every account.

### Handing over ownership

- **Team page → Make owner** (owner only): the teammate becomes the owner, you stay on as an admin. With `PASSWORD_SIGNIN=owner` they need a password first, because the owner is the one who can still sign in when Microsoft is unavailable.
- **On the server**, when the owner can't sign in or is someone outside the company tenant (e.g. a Gmail address): `./scripts/set-owner.sh person@example.com "Their Name"`. It asks for the password (hidden), creates the person if needed, and makes them the owner. Recorded in the audit log as done by *System*.

## Account grants (Staff)

Levels are ordered: `READ` < `REPLY` < `FULL`. A higher level includes everything below it.

| Level | Allows |
|---|---|
| *(no grant)* | The account does not exist for them: it is hidden from lists and its URLs answer 404 |
| `READ` | Read conversations, messages and attachments, see the network/connections list, read and add internal notes, mark as read, release their own lock, get notifications |
| `REPLY` | + send messages and attachments, start new chats from Network, take a conversation lock, assign/status/labels on a conversation, force a sync, AI reply drafts, **watch** Live View (view only) |
| `FULL` | + import the account's LinkedIn data archive, **control** Live View (click/type in the LinkedIn browser), account settings (label, timezone, proxy, send cap, pause), restart the browser, manage who has access to this account, account alerts by email |

Extra rules:
- Disconnecting (deleting) an account needs `FULL` **and** being the account's owner or an admin.
- The member who connected an account is its owner and gets `FULL` on it. While the account is not connected yet (login, 2FA, checkpoint), its owner can always control Live View to finish logging in.
- Only admins and the owner connect new LinkedIn accounts; staff work the accounts assigned to them. Anyone can create labels. Editing/deleting labels, users, webhooks and reading the audit log is admin-only.
- With `PASSWORD_SIGNIN=owner`, staff and admins sign in with Microsoft 365 only: the app refuses to give them a password.
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
| Account's real owner (the person whose LinkedIn it is) | Staff | `FULL` on their own account |
| SDR / assistant who answers messages | Staff | `REPLY` on the accounts they work |
| Manager / reviewer | Staff | `READ` |

Keep `FULL` small: it allows driving the LinkedIn browser directly (profile, settings, posts).

## Audit log

Settings → Audit (owner and admins) records sign-ins (also failed ones, with the reason; never passwords), sign-outs, messages sent, Live View sessions, account and access changes, team changes, staff sync actions and exports. Each entry keeps the person's name/email and the account name as they were at the time, with IP address and browser.

- Filter by person, LinkedIn account, event (or a whole category) and date range.
- **Export** the filtered log as CSV (opens in Excel with accents intact; cells that look like formulas are kept as text) or JSON. Exports have no size limit and are themselves recorded.
- Entries can't be edited or deleted by the application (database trigger); removing a teammate or account only clears the link, the names stay.
