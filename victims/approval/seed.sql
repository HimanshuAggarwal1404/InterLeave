-- Starting state for the approval victim: request 1 is pending (version 1).
CREATE TABLE IF NOT EXISTS approval_requests (
    id      int  PRIMARY KEY,
    status  text NOT NULL,
    version int  NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
    id         serial PRIMARY KEY,
    request_id int  NOT NULL,
    approver   text NOT NULL
);

TRUNCATE approval_requests, approvals RESTART IDENTITY;

INSERT INTO approval_requests (id, status, version) VALUES (1, 'pending', 1);
