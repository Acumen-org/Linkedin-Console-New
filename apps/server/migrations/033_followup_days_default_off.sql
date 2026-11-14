-- Auto follow-up reminders now default OFF for newly connected accounts (ext plan: the external CRM owns follow-up
-- scheduling, so the console shouldn't also create reminders/Twenty tasks). This changes only the default for new
-- accounts; existing accounts keep their current followup_days until an admin sets them to 0 in the Console.
ALTER TABLE accounts ALTER COLUMN followup_days SET DEFAULT 0;
