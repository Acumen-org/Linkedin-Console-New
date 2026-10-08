# Roadmap (revised 2026-10-08)

The original design is in [master-plan.md](master-plan.md). This is the order of work from here. One phase at a time; each is tested (lint, typecheck, unit tests, Docker end-to-end) before it ships.

**Rule:** no new features while known crash, data-loss or security bugs are open.

| Phase | Goal | Contents |
|---|---|---|
| **1. Stabilize** | Nothing breaks | Audit Tier 1: sync data corruption, sidecar crashes and memory limits, lost stream entries, races, security holes (pod isolation, image updates, IPv6 firewall, cookies, sign-in hardening), web session expiry and reconnect catch-up. Top performance fixes (refetch storm, account list queries, attachment check, scoped search). |
| **2. First-sync experience** | A newly connected account looks complete | Within about a minute: the 100 most recent conversations and connections. Within about 5 minutes: recent history of those 100 chats, newest first, with any opened chat jumping the queue. Remaining connections in the background with progress and a time estimate. |
| **3. Safe volume** | More results without bans | Separate daily caps for replies and new chats; gradual automatic ramp-up per account; automatic pause plus admin alert on any LinkedIn warning (checkpoint, limit notice, unusual activity). No parallel or cloned browsers per account: LinkedIn's limits are per account, and parallel sessions are a strong automation signal. |
| **4. Safe operations** | Mistakes are recoverable | Version-tagged images; images and Chrome refreshed on update; backups that restore cleanly (paused profiles, `.env`, retention, cache excluded); worker heartbeat health check; Postgres tuning and memory protection. |
| **5. Data in and out** | Complete history, easy export | Archive import (Connections.csv, messages.csv) merged without duplicates; chat export (latest N conversations with full history, background job, admins only, audited, expiring download); Sponsored InMail handling (waits for the raw capture). |
| **6. Polish** | Comfortable for ~100 staff | Remaining audit items (paging cursors, stale view rows, label races, typing indicator, push after logout), mobile layout, optional Auditor and Supervisor roles. |
| **7. Scale** | Only when needed | A second VM, and only then a scheduler such as Nomad (one VM handles about 30 accounts). |
