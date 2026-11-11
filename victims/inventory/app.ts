// The inventory victim: two customers order the last item in stock.
//
// POST /order {"product": "widget", "qty": 1, "user_id": 1} checks the stock
// with a plain SELECT, then decrements it in a separate UPDATE
// (check-then-act). Two concurrent orders for the last widget can both see
// stock 1 and both succeed: the stock goes to -1.
// --fixed checks and acts in one statement: UPDATE ... WHERE stock >= qty.
import type http from 'node:http';
import type pg from 'pg';
import { BadRequest, endpoint, int, sqlInt, sqlText, text, transaction, type Query, type Reply } from '../common/kit.ts';

export function newHandler(pool: pg.Pool, fixed: boolean): http.RequestListener {
  return endpoint('/order', async (body, tc) => {
    const product = text(body, 'product');
    const qty = int(body, 'qty');
    const userId = int(body, 'user_id');
    if (qty < 1) {
      throw new BadRequest('qty: want at least 1');
    }
    return transaction(pool, tc, (q) => (fixed ? orderFixed : orderBuggy)(q, product, qty, userId));
  });
}

async function orderBuggy(q: Query, product: string, qty: number, userId: number): Promise<Reply> {
  // Check.
  const { rows } = await q<{ stock: number }>(`SELECT stock FROM products WHERE name = ${sqlText(product)}`);
  if (rows.length === 0) {
    return [404, 'unknown product'];
  }
  if (rows[0].stock < qty) {
    return [409, 'out of stock'];
  }
  // Act. THE BUG: another order may have taken the stock since our SELECT,
  // but we go ahead because our (now stale) check passed.
  await q(`UPDATE products SET stock = stock - ${sqlInt(qty)} WHERE name = ${sqlText(product)}`);
  await q(`INSERT INTO orders (product, qty, user_id) VALUES (${sqlText(product)}, ${sqlInt(qty)}, ${sqlInt(userId)})`);
  return [200, 'ordered'];
}

async function orderFixed(q: Query, product: string, qty: number, userId: number): Promise<Reply> {
  // THE FIX: check and act in one statement. An UPDATE re-checks its WHERE on
  // the newest version of the row (after waiting for any concurrent writer),
  // so a second order sees stock 0 and changes no row.
  const res = await q(`UPDATE products SET stock = stock - ${sqlInt(qty)} WHERE name = ${sqlText(product)} AND stock >= ${sqlInt(qty)}`);
  if (res.rowCount === 0) {
    const exists = await q(`SELECT 1 FROM products WHERE name = ${sqlText(product)}`);
    return exists.rows.length === 0 ? [404, 'unknown product'] : [409, 'out of stock'];
  }
  await q(`INSERT INTO orders (product, qty, user_id) VALUES (${sqlText(product)}, ${sqlInt(qty)}, ${sqlInt(userId)})`);
  return [200, 'ordered'];
}
