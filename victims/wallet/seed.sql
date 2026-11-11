-- Starting state for the wallet victim: wallet 1 holds 100.
CREATE TABLE IF NOT EXISTS wallets (
    id      int PRIMARY KEY,
    balance int NOT NULL
);

CREATE TABLE IF NOT EXISTS withdrawals (
    id     serial PRIMARY KEY,
    wallet int NOT NULL,
    amount int NOT NULL
);

TRUNCATE wallets, withdrawals RESTART IDENTITY;

INSERT INTO wallets (id, balance) VALUES (1, 100);
