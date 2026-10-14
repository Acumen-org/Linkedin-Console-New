-- Exactly one owner. Ownership can be handed over (Team page, or scripts/set-owner.sh on the server); an install
-- that somehow has several keeps the oldest as owner and the others become admins.
UPDATE users SET role = 'ADMIN'
WHERE role = 'OWNER' AND id <> (SELECT id FROM users WHERE role = 'OWNER' ORDER BY created_at, id LIMIT 1);
CREATE UNIQUE INDEX users_single_owner ON users ((true)) WHERE role = 'OWNER';
