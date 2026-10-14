-- The last conversation list load of an account: how many conversations LinkedIn's page listed, how many its
-- data described, how many had to be read from the page itself. Shown in the sync report; a big gap alerts.
ALTER TABLE accounts ADD COLUMN inbox_check jsonb;
