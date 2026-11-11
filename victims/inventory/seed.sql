-- Starting state for the inventory victim: one widget left in stock.
CREATE TABLE IF NOT EXISTS products (
    name  text PRIMARY KEY,
    stock int  NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
    id      serial PRIMARY KEY,
    product text NOT NULL,
    qty     int  NOT NULL,
    user_id int  NOT NULL
);

TRUNCATE products, orders RESTART IDENTITY;

INSERT INTO products (name, stock) VALUES ('widget', 1);
