-- Starting state for the coupon victim. Safe to run before every attempt:
-- creates the tables if missing, then resets them to one unused coupon.
CREATE TABLE IF NOT EXISTS coupons (
    code     text PRIMARY KEY,
    max_uses int  NOT NULL,
    uses     int  NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS redemptions (
    id      serial PRIMARY KEY,
    code    text NOT NULL,
    user_id int  NOT NULL
);

TRUNCATE coupons, redemptions RESTART IDENTITY;

INSERT INTO coupons (code, max_uses, uses) VALUES ('DIWALI50', 1, 0);
