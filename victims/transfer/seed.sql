-- Starting state for the transfer victim: accounts 1 and 2 hold 100 each.
CREATE TABLE IF NOT EXISTS accounts (
    id      int PRIMARY KEY,
    balance int NOT NULL
);

CREATE TABLE IF NOT EXISTS transfers (
    id           serial PRIMARY KEY,
    from_account int NOT NULL,
    to_account   int NOT NULL,
    amount       int NOT NULL
);

TRUNCATE accounts, transfers RESTART IDENTITY;

INSERT INTO accounts (id, balance) VALUES (1, 100), (2, 100);
