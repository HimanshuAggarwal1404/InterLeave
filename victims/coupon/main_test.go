package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"racehound/internal/proxy"
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

// TestQueriesCarryRequestTag runs the app through a real RaceHound proxy and
// checks which statements carry the tag from the X-RaceHound-Req header.
func TestQueriesCarryRequestTag(t *testing.T) {
	resetDB(t, testPool(t))
	seen := &queryLog{}
	srv := httptest.NewServer(newHandler(poolViaProxy(t, seen.record)))
	defer srv.Close()

	// A redeems the unused coupon: every statement, BEGIN to COMMIT, is tagged.
	if got := post(t, srv.URL, "A"); got != http.StatusOK {
		t.Fatalf("request A: status %d, want 200", got)
	}
	tagged, untagged := seen.take()
	if want := []string{"A BEGIN", "A SELECT", "A UPDATE", "A INSERT", "A COMMIT"}; !slices.Equal(tagged, want) {
		t.Errorf("request A: tagged statements %v, want %v", tagged, want)
	}

	// B finds it used up: BEGIN and SELECT are tagged; pgx's ROLLBACK cannot
	// be, so it passes through untagged (D-016).
	if got := post(t, srv.URL, "B"); got != http.StatusConflict {
		t.Fatalf("request B: status %d, want 409", got)
	}
	tagged, untagged = seen.take()
	if want := []string{"B BEGIN", "B SELECT"}; !slices.Equal(tagged, want) {
		t.Errorf("request B: tagged statements %v, want %v", tagged, want)
	}
	if !slices.Contains(untagged, "ROLLBACK") {
		t.Errorf("request B: untagged statements %v, want a ROLLBACK", untagged)
	}

	// No header (curl, cmd/bench): nothing is tagged.
	if got := post(t, srv.URL, ""); got != http.StatusConflict {
		t.Fatalf("untagged request: status %d, want 409", got)
	}
	tagged, untagged = seen.take()
	if len(tagged) != 0 || !slices.Contains(untagged, "SELECT") {
		t.Errorf("untagged request: tagged %v, untagged %v; want no tags", tagged, untagged)
	}

	// The header goes into SQL, so anything but a plain tag is refused.
	for _, bad := range []string{"A */ DROP TABLE coupons; --", "A B", strings.Repeat("a", 65)} {
		if got := post(t, srv.URL, bad); got != http.StatusBadRequest {
			t.Errorf("header %q: status %d, want 400", bad, got)
		}
	}
	if tagged, untagged = seen.take(); len(tagged)+len(untagged) != 0 {
		t.Errorf("rejected requests ran SQL: %v %v", tagged, untagged)
	}
}

// poolViaProxy starts an in-process RaceHound proxy in front of the local
// Postgres, reporting every query to onQuery, and returns a pool through it.
func poolViaProxy(t *testing.T, onQuery func(tag, sql string)) *pgxpool.Pool {
	t.Helper()
	p, err := proxy.New("localhost:5432")
	if err != nil {
		t.Fatal(err)
	}
	p.OnQuery = onQuery
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- p.Serve(ctx, ln) }()

	dsn := strings.Replace(directDSN, "localhost:5432", ln.Addr().String(), 1)
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		cancel()
		if err := <-done; err != nil {
			t.Errorf("proxy Serve: %v", err)
		}
	})
	return pool
}

// post sends one redeem request with the given X-RaceHound-Req header ("" for
// none) and returns the HTTP status.
func post(t *testing.T, baseURL, tag string) int {
	t.Helper()
	body, _ := json.Marshal(redeemRequest{Code: "DIWALI50", UserID: 1})
	req, err := http.NewRequest(http.MethodPost, baseURL+"/redeem", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if tag != "" {
		req.Header.Set("X-RaceHound-Req", tag)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp.StatusCode
}

// queryLog collects what the proxy saw. The proxy calls record from its
// connection goroutines while the test reads, hence the mutex.
type queryLog struct {
	mu       sync.Mutex
	tagged   []string // tag and first SQL keyword, e.g. "A SELECT"
	untagged []string // first SQL keyword, e.g. "ROLLBACK"
}

func (l *queryLog) record(tag, sql string) {
	if i := strings.Index(sql, "*/"); tag != "" && i >= 0 {
		sql = sql[i+2:] // drop the tag comment
	}
	words := strings.Fields(sql)
	if len(words) == 0 {
		return
	}
	keyword := strings.ToUpper(words[0])
	l.mu.Lock()
	defer l.mu.Unlock()
	if tag == "" {
		l.untagged = append(l.untagged, keyword)
	} else {
		l.tagged = append(l.tagged, tag+" "+keyword)
	}
}

// take returns and clears what was recorded.
func (l *queryLog) take() (tagged, untagged []string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	tagged, untagged = l.tagged, l.untagged
	l.tagged, l.untagged = nil, nil
	return tagged, untagged
}
