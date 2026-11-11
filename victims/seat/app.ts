// The seat victim: two users book the same seat on a flight.
//
// POST /book {"seat": "12A", "user_id": 1} checks that nobody has booked the
// seat yet (a count), then inserts the booking. Two concurrent bookings can
// both count 0 and both insert: the seat is sold twice.
// --fixed locks the seat's row (SELECT ... FOR UPDATE) before the check.
import type http from 'node:http';
import type pg from 'pg';
import { endpoint, int, sqlInt, sqlText, text, transaction, type Query, type Reply } from '../common/kit.ts';

export function newHandler(pool: pg.Pool, fixed: boolean): http.RequestListener {
  return endpoint('/book', async (body, tc) => {
    const seat = text(body, 'seat');
    const userId = int(body, 'user_id');
    return transaction(pool, tc, (q) => book(q, seat, userId, fixed));
  });
}

async function book(q: Query, seat: string, userId: number, fixed: boolean): Promise<Reply> {
  // THE FIX: lock the seat's row first. A second booking for the same seat
  // waits here until the first transaction ends, and its count below then
  // sees the first booking (each statement reads the latest committed data).
  // THE BUG (without it): nothing stops both bookings from counting 0 before
  // either inserts; there is no unique constraint on bookings.seat to catch it.
  const lock = fixed ? ' FOR UPDATE' : '';
  const seats = await q(`SELECT id FROM seats WHERE id = ${sqlText(seat)}${lock}`);
  if (seats.rows.length === 0) {
    return [404, 'unknown seat'];
  }
  const { rows } = await q<{ n: number }>(`SELECT count(*)::int AS n FROM bookings WHERE seat = ${sqlText(seat)}`);
  if (rows[0].n > 0) {
    return [409, 'seat taken'];
  }
  await q(`INSERT INTO bookings (seat, user_id) VALUES (${sqlText(seat)}, ${sqlInt(userId)})`);
  return [200, 'booked'];
}
