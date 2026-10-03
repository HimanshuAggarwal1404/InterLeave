package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// TestRaceIsReal is the Phase 0 exit test. It fires many concurrent redeems at
// the app (talking straight to Postgres, no RaceHound) and expects the
// single-use coupon to be redeemed more than once in at least one round.
// Whether the bad interleaving happens depends on timing, so it tries several
// rounds. This is the luck-based "blasting" that RaceHound will replace.
func TestRaceIsReal(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	srv := httptest.NewServer(newHandler(pool))
	defer srv.Close()

	const rounds, concurrent = 20, 50
	for round := 1; round <= rounds; round++ {
		resetDB(t, pool)
		fireConcurrently(t, srv.URL, concurrent)

		var uses, maxUses, redemptions int
		err := pool.QueryRow(ctx, `SELECT uses, max_uses,
			(SELECT count(*) FROM redemptions WHERE code = 'DIWALI50')
			FROM coupons WHERE code = 'DIWALI50'`).Scan(&uses, &maxUses, &redemptions)
		if err != nil {
			t.Fatalf("round %d: read coupon: %v", round, err)
		}
		if uses > maxUses {
			t.Logf("round %d: single-use coupon redeemed %d times (%d redemption rows)",
				round, uses, redemptions)
			return
		}
	}
	t.Fatalf("no over-redeem in %d rounds of %d concurrent requests", rounds, concurrent)
}

// testPool connects to the racehound database directly (port 5432, bypassing
// the proxy). Set RACEHOUND_TEST_DSN to use a different database.
func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("RACEHOUND_TEST_DSN")
	if dsn == "" {
		dsn = directDSN
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("bad DSN: %v", err)
	}
	if err := pool.Ping(context.Background()); err != nil {
		pool.Close()
		t.Skipf("Postgres not reachable, skipping: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// resetDB runs seed.sql so every round starts from the same state.
func resetDB(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	seed, err := os.ReadFile("seed.sql")
	if err != nil {
		t.Fatalf("read seed.sql: %v", err)
	}
	if _, err := pool.Exec(context.Background(), string(seed)); err != nil {
		t.Fatalf("run seed.sql: %v", err)
	}
}

// fireConcurrently sends n redeem requests (user IDs 1..n) as close to
// simultaneously as possible: every goroutine waits on the start channel, and
// closing it releases them all at once.
func fireConcurrently(t *testing.T, baseURL string, n int) {
	t.Helper()
	start := make(chan struct{})
	var wg sync.WaitGroup
	for userID := 1; userID <= n; userID++ {
		wg.Go(func() {
			<-start
			body, _ := json.Marshal(redeemRequest{Code: "DIWALI50", UserID: userID})
			resp, err := http.Post(baseURL+"/redeem", "application/json", bytes.NewReader(body))
			if err != nil {
				t.Errorf("user %d: %v", userID, err)
				return
			}
			resp.Body.Close()
		})
	}
	close(start)
	wg.Wait()
}
