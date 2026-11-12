-- Starting state for the ledger victim: account 1 holds 100.
CREATE TABLE IF NOT EXISTS ledger_accounts (
    id      int PRIMARY KEY,
    balance int NOT NULL
);

-- Every deposit and fee, so the balance can be checked against them.
CREATE TABLE IF NOT EXISTS ledger_entries (
    id      serial PRIMARY KEY,
    account int  NOT NULL,
    kind    text NOT NULL,
    amount  int  NOT NULL
);

-- The month-end close's audit lines (the long part of its transaction).
CREATE TABLE IF NOT EXISTS ledger_audit (
    id      serial PRIMARY KEY,
    account int NOT NULL,
    line    int NOT NULL
);

TRUNCATE ledger_accounts, ledger_entries, ledger_audit RESTART IDENTITY;

INSERT INTO ledger_accounts (id, balance) VALUES (1, 100);
