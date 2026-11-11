-- Starting state for the seat victim: seat 12A, not booked yet.
CREATE TABLE IF NOT EXISTS seats (
    id text PRIMARY KEY
);

-- No unique constraint on seat: the app's check is all that prevents a double booking.
CREATE TABLE IF NOT EXISTS bookings (
    id      serial PRIMARY KEY,
    seat    text NOT NULL,
    user_id int  NOT NULL
);

TRUNCATE seats, bookings RESTART IDENTITY;

INSERT INTO seats (id) VALUES ('12A');
