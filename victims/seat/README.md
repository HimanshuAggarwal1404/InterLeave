# seat victim

**Bug:** `POST /book` counts the existing bookings for the seat and inserts a new one if the count
is 0, so two concurrent bookings can both count 0 and both insert: the seat is sold twice.

## Bad interleaving

```
Request A                                  Request B
BEGIN
SELECT id FROM seats WHERE id = '12A'
                                           BEGIN
                                           SELECT id FROM seats WHERE id = '12A'
SELECT count(*) FROM bookings → 0
                                           SELECT count(*) FROM bookings → 0   (A has not inserted)
INSERT INTO bookings ('12A', 1)
COMMIT
                                           INSERT INTO bookings ('12A', 2)
                                           COMMIT                 → two bookings for 12A
```

## Fix (`--fixed`): lock the seat row before checking

`SELECT id FROM seats WHERE id = '12A' FOR UPDATE` takes a row lock that is held until the
transaction ends. B's `FOR UPDATE` waits for A's commit; B's count then runs with a fresh snapshot
(READ COMMITTED takes one per statement), sees A's booking, and B answers 409. The seats row works
as a mutex for "bookings of this seat". (A unique constraint on `bookings.seat` would also stop it,
by making B's insert fail.)

## Run it

```bash
node victims/seat/main.ts                      # buggy, on 127.0.0.1:8083, database via 127.0.0.1:6433
npm run interleave -- run victims/seat/scenario.yaml
```
