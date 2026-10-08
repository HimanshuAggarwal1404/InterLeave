//go:build sched

// The Phase 1 exit test. It needs the sched package, so until sched exists it
// only builds with the "sched" tag:
//
//	go test -race -tags sched ./victims/coupon -run TestKillTest -v
//
// Remove the build line above once sched passes its own tests.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"interleave/internal/sched"
)

// TestKillTest is the Phase 1 exit test (ROADMAP): a hard-coded schedule
// reproduces the coupon double-redeem 10/10 times, and the opposite order
// never does. Requests A and B are fired at the same moment through the real
// proxy; only the scheduler decides which statement runs when.
func TestKillTest(t *testing.T) {
	pool := testPool(t) // skips the test if Postgres is down

	// A and B each do BEGIN, SELECT, UPDATE, INSERT, COMMIT. Both SELECTs run
	// before either UPDATE: both see uses = 0 and both redeem.
	bad := []string{"A", "A", "B", "B", "A", "A", "A", "B", "B", "B"}
	for i := 1; i <= 10; i++ {
		statuses, uses := redeemInOrder(t, pool, bad)
		if uses != 2 || statuses["A"] != http.StatusOK || statuses["B"] != http.StatusOK {
			t.Fatalf("bad order, run %d: uses = %d, statuses %v; want the double-redeem (2, both 200)",
				i, uses, statuses)
		}
	}

	// The opposite: A runs to COMMIT before B starts. B's SELECT sees uses = 1
	// and B is refused; its ROLLBACK is untagged and not scheduled (D-016).
	serial := []string{"A", "A", "A", "A", "A", "B", "B"}
	for i := 1; i <= 10; i++ {
		statuses, uses := redeemInOrder(t, pool, serial)
		if uses != 1 || statuses["A"] != http.StatusOK || statuses["B"] != http.StatusConflict {
			t.Fatalf("serial order, run %d: uses = %d, statuses %v; want 1, A 200, B 409",
				i, uses, statuses)
		}
	}
}

// redeemInOrder resets the database, fires redeem requests A and B together
// through a proxy driven by a scheduler with the given order, and returns each
// request's HTTP status and the coupon's final use count.
func redeemInOrder(t *testing.T, pool *pgxpool.Pool, order []string) (map[string]int, int) {
	t.Helper()
	resetDB(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	s := sched.New(order)
	type runResult struct {
		trace []sched.Step
		err   error
	}
	run := make(chan runResult, 1)
	go func() {
		trace, err := s.Run(ctx)
		run <- runResult{trace, err}
	}()

	srv := httptest.NewServer(newHandler(poolViaProxy(t, s.OnQuery), false))
	defer srv.Close()

	statuses := map[string]int{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	for i, tag := range []string{"A", "B"} {
		wg.Go(func() {
			status, err := postTagged(ctx, srv.URL, tag, i+1)
			if err != nil {
				t.Errorf("request %s: %v", tag, err)
				return
			}
			mu.Lock()
			statuses[tag] = status
			mu.Unlock()
		})
	}
	wg.Wait()

	var res runResult
	select {
	case res = <-run:
	case <-ctx.Done():
		t.Fatalf("order %v: scheduler did not finish: %v", order, ctx.Err())
	}
	if res.err != nil {
		t.Fatalf("order %v: Run returned %v", order, res.err)
	}
	var tags []string
	for _, st := range res.trace {
		tags = append(tags, st.Tag)
	}
	if !slices.Equal(tags, order) {
		t.Fatalf("scheduler ran %v, want the order %v", tags, order)
	}
	uses, _, _ := readCoupon(t, pool)
	return statuses, uses
}

// postTagged sends one redeem request as Interleave would: with the
// X-Interleave-Req header naming the request. Safe to call from goroutines.
func postTagged(ctx context.Context, baseURL, tag string, userID int) (int, error) {
	body, err := json.Marshal(redeemRequest{Code: "DIWALI50", UserID: userID})
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/redeem", bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("X-Interleave-Req", tag)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, err
	}
	resp.Body.Close()
	return resp.StatusCode, nil
}
