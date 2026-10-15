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

### Following the staff list (Twenty CRM or the Twilio console)

`STAFF_SOURCE` picks the list:

- `twenty`: the members of your **Twenty CRM workspace** (`TWENTY_API_URL` = its `/graphql` address, `TWENTY_API_KEY` = an API key from Twenty; the same values the Twilio console uses). Someone removed from the workspace is disabled and signed out here at the next sync; added back, they are re-enabled. Every page of members is read, and an error or an empty workspace changes nothing.
- `twilio` (default): the Twilio console's staff list, described below.

Links are kept per source, so switching `STAFF_SOURCE` never mistakes someone linked through the other list for a leaver.

#### The Twilio console staff list

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

## Assigning staff to accounts

- **Team → Assign** on a staff member: every LinkedIn account with a level (No access, Read, Reply, Full) for that person.
- **Several at once:** tick staff on the Team page → **Assign accounts** → pick accounts and a level (or Remove access).
- **Accounts → Team access**: the same, per account.

Only admins and the owner assign; only staff get assignments (admins see everything, auditors nothing). Full asks for confirmation. Changes apply at once, also to people who are signed in, and each change is recorded in the audit log under the account (only real changes, not saves that change nothing).

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

## Staff activity

**Activity** (owner, admins and auditors) shows, per teammate and period (today, 7, 30 or 90 days) and optionally per LinkedIn account: messages sent, new chats started, conversations handled, typical reply time (median time from the prospect's message to the reply) and failed sends. Click a teammate to see every message they sent, with the time, prospect and account. **Export** gives the same as CSV (Excel) or JSON; exports are recorded in the audit log.

Only messages sent from this app are counted. Reading conversations is not tracked.

## Twenty CRM: prospects and messages

With `CRM_SYNC=on` (and `TWENTY_API_URL`, `TWENTY_API_KEY`). Duplicates are prevented, not merged afterwards (master plan, 16 Oct):

- **Nothing reaches Twenty until the prospect replies.** Messaging someone who never answers creates nothing there (no Person, no note, no follow-up task).
- **After a reply the prospect is bound to exactly one Person.** Automatically only when exactly one Person in Twenty has their LinkedIn profile link (however it was typed: with or without www, a trailing slash, tracking parameters). Otherwise (no Person has it, several do, or the profile link isn't known yet) the conversation waits in **Needs CRM binding** for a teammate. Never by name, never by email; the console never creates a Person by itself.
- **A binding belongs to the prospect**, not the conversation: every conversation with them, in any account, goes to the same Person.
- **Once bound**, every message from the moment the sync was switched on becomes a note on that Person (also the ones sent before the reply; nothing is lost while waiting), and follow-up reminders become tasks on it.
- **Persons the earlier sync created** for prospects who never replied (or a second Person it made for the same prospect) are unlinked and marked **LinkedIn Console: review** in Twenty for CS to clean up. Nothing is deleted.
- A Person deleted or merged in Twenty unbinds the prospect, who is then looked at again.
- The Team page shows prospects bound, replies waiting to be bound, messages logged, and the review marks.

**Twenty fields.** `./scripts/twenty-fields.sh` lists which LinkedIn Console fields Person has (LinkedIn Console source, LinkedIn status, Last LinkedIn message sent / received, LinkedIn member ID) and which are missing; it changes nothing. `./scripts/twenty-fields.sh --apply` adds the missing ones (custom, nullable; existing fields are never changed). The console only writes fields that exist, so the review mark waits until that field is there.

## Follow-up reminders

Each prospect (conversation) can have one open follow-up reminder: the bell in the conversation header sets it (tomorrow, in 3 days, next Monday, in 2 weeks, or a date and time) with an optional note, moves it, or closes it as **Done** (followed up) or **Close prospect** (stop following up). Anyone with Reply access can do this; each change is in the audit log.

- **Who it is for** follows the conversation: its assignee, else the last teammate who messaged the prospect, else everyone who can reply on the account.
- **When it comes due**, they get a notification (once; moving it notifies again).
- **Inbox → Follow-ups** lists every prospect with an open reminder, soonest first, overdue in red. Every conversation in the list shows its reminder date and who it is for. **Replied** and **No reply yet** show whether the prospect has answered.
- **In Twenty CRM** (with `CRM_SYNC=on`): each reminder is a **task** on the prospect's person, due at the same time and assigned to the teammate's Twenty workspace member (staff from `STAFF_SOURCE=twenty`). Moving or closing it here updates the task; marking the task done (or deleting it) in Twenty closes the reminder here, and a new due date there moves it here.

### Automatic follow-ups

Per LinkedIn account (Accounts → settings, default **10**, 0 = off): when our message is the last one in a 1:1 conversation and the prospect stays silent for that many **business days** (weekends don't count), a follow-up reminder is created for the teammate responsible, due at **9:00 in the account's timezone** on that weekday, with the note "No reply for N business days since our last message". It notifies, shows under Follow-ups and becomes a Twenty task like any reminder.

- Nothing is created on a weekend (in the account's timezone).
- One per silence: not when the prospect already has a reminder for it (open, or set or closed since our last message).
- Not for a prospect marked **Close prospect**, until they write again.
- When the prospect replies, an open automatic reminder closes itself.
- Silences older than the account's days plus two weeks are left alone, so switching it on doesn't flood the team.
- The quick picks for manual reminders skip weekends too (next business day, in 3 business days, next Monday, in 2 weeks).

## Staff send limits

Team page → **Staff send limits**: a limit per staff member per 24 hours (messages and new chats together, over all accounts), on top of each account's own limit; 0 = none. Each staff member can have their own (**Assign** → Send limit; blank = the team default, 0 = none). The Team page shows how many each sent in the last 24 hours. Admins and the owner have no personal limit.

A staff member at their limit gets "You reached your limit…" and can't send until older sends fall out of the 24 hours. Admins (owner and admins) are notified, once a day per person and reason, in their browser and by email when SMTP is set up, when someone reaches 80 % of their limit or sends more than the alert threshold (default 30) within an hour. Each alert is in the audit log.
