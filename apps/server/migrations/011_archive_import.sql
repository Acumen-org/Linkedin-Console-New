-- When each connection was made (from LinkedIn's data archive, Connections.csv "Connected On").
ALTER TABLE contacts ADD COLUMN connected_at date;
