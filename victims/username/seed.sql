-- Starting state for the username victim: no members yet.
-- No unique constraint on username: the app's check is all that keeps names unique.
CREATE TABLE IF NOT EXISTS members (
    id       serial PRIMARY KEY,
    username text NOT NULL
);

TRUNCATE members RESTART IDENTITY;
