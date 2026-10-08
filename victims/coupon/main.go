// Command coupon is a deliberately racy victim app for Interleave.
//
// POST /redeem {"code": "DIWALI50", "user_id": 1} redeems a coupon if it has
// uses left. It checks the count with a plain SELECT and then increments it in
// a separate statement (check-then-act). BEGIN does not make this safe: under
// READ COMMITTED (the Postgres default) a plain SELECT takes no lock, so two
// concurrent requests can both see uses = 0 and both redeem a single-use coupon.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	// proxyDSN goes through Interleave (default). directDSN bypasses it.
	proxyDSN  = "postgres://interleave:interleave@localhost:6433/interleave?sslmode=disable&default_query_exec_mode=simple_protocol"
	directDSN = "postgres://interleave:interleave@localhost:5432/interleave?sslmode=disable&default_query_exec_mode=simple_protocol"
)

type redeemRequest struct {
	Code   string `json:"code"`
	UserID int    `json:"user_id"`
}

func main() {
	addr := flag.String("addr", "localhost:8081", "HTTP listen address")
	dsn := flag.String("dsn", proxyDSN, "Postgres connection string (use port 5432 to bypass Interleave)")
	flag.Parse()

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, *dsn)
	if err != nil {
		log.Fatalf("invalid DSN: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		log.Fatalf("cannot reach Postgres at %s: %v", *dsn, err)
	}

	log.Printf("coupon victim listening on http://%s", *addr)
	log.Fatal(http.ListenAndServe(*addr, newHandler(pool)))
}

func newHandler(pool *pgxpool.Pool) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /redeem", func(w http.ResponseWriter, r *http.Request) {
		// Interleave names each request it fires (A, B, ...). The tag goes into
		// SQL, so anything but a plain tag is refused (no SQL injection).
		tag := r.Header.Get("X-Interleave-Req")
		if tag != "" && !validTag(tag) {
			http.Error(w, "invalid X-Interleave-Req header", http.StatusBadRequest)
			return
		}
		var req redeemRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		status, msg := redeem(r.Context(), pool, tagComment(tag), req)
		w.WriteHeader(status)
		fmt.Fprintln(w, msg)
	})
	return mux
}

// redeem returns the HTTP status and message for one redemption attempt.
// tc is the Interleave tag comment that starts every statement ("" if none).
func redeem(ctx context.Context, pool *pgxpool.Pool, tc string, req redeemRequest) (int, string) {
	// pgx lets us choose the BEGIN and COMMIT text, so those are tagged too.
	// Its ROLLBACK cannot be, so it passes through Interleave unscheduled (D-016).
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{BeginQuery: tc + "BEGIN", CommitQuery: tc + "COMMIT"})
	if err != nil {
		return serverError(err)
	}
	defer tx.Rollback(ctx) // no-op once Commit has succeeded

	// Check.
	var uses, maxUses int
	err = tx.QueryRow(ctx, tc+"SELECT uses, max_uses FROM coupons WHERE code = $1", req.Code).
		Scan(&uses, &maxUses)
	if errors.Is(err, pgx.ErrNoRows) {
		return http.StatusNotFound, "unknown coupon"
	}
	if err != nil {
		return serverError(err)
	}
	if uses >= maxUses {
		return http.StatusConflict, "coupon already used up"
	}

	// Act. THE BUG: another request may have redeemed the coupon since our
	// SELECT, but we go ahead because our (now stale) check passed.
	if _, err := tx.Exec(ctx, tc+"UPDATE coupons SET uses = uses + 1 WHERE code = $1", req.Code); err != nil {
		return serverError(err)
	}
	if _, err := tx.Exec(ctx, tc+"INSERT INTO redemptions (code, user_id) VALUES ($1, $2)", req.Code, req.UserID); err != nil {
		return serverError(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return serverError(err)
	}
	return http.StatusOK, "redeemed"
}

func serverError(err error) (int, string) {
	log.Printf("redeem: %v", err)
	return http.StatusInternalServerError, "internal error"
}

// tagComment returns the SQL comment that tells Interleave which request a
// statement belongs to, e.g. "/* il:req=A */ ", or "" without a tag.
func tagComment(tag string) string {
	if tag == "" {
		return ""
	}
	return "/* il:req=" + tag + " */ "
}

// validTag accepts the tags Interleave uses: 1-64 of A-Z a-z 0-9 _ -.
func validTag(tag string) bool {
	if len(tag) > 64 {
		return false
	}
	for _, c := range []byte(tag) {
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
			return false
		}
	}
	return tag != ""
}
