-- Starting state for the counter victim: the visits counter is at 0.
CREATE TABLE IF NOT EXISTS counters (
    name text PRIMARY KEY,
    n    int  NOT NULL
);

-- One row per successful increment: what the counter should say.
CREATE TABLE IF NOT EXISTS increments (
    id      serial PRIMARY KEY,
    counter text NOT NULL
);

TRUNCATE counters, increments RESTART IDENTITY;

INSERT INTO counters (name, n) VALUES ('visits', 0);
