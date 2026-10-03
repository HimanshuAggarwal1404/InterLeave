// Command coupon is a deliberately racy victim app for RaceHound.
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
	// proxyDSN goes through RaceHound (default). directDSN bypasses it.
	proxyDSN  = "postgres://racehound:racehound@localhost:6433/racehound?sslmode=disable&default_query_exec_mode=simple_protocol"
	directDSN = "postgres://racehound:racehound@localhost:5432/racehound?sslmode=disable&default_query_exec_mode=simple_protocol"
)

type redeemRequest struct {
	Code   string `json:"code"`
	UserID int    `json:"user_id"`
}

func main() {
	addr := flag.String("addr", "localhost:8081", "HTTP listen address")
	dsn := flag.String("dsn", proxyDSN, "Postgres connection string (use port 5432 to bypass RaceHound)")
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
		var req redeemRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		status, msg := redeem(r.Context(), pool, req)
		w.WriteHeader(status)
		fmt.Fprintln(w, msg)
	})
	return mux
}

// redeem returns the HTTP status and message for one redemption attempt.
func redeem(ctx context.Context, pool *pgxpool.Pool, req redeemRequest) (int, string) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return serverError(err)
	}
	defer tx.Rollback(ctx) // no-op once Commit has succeeded

	// Check.
	var uses, maxUses int
	err = tx.QueryRow(ctx, "SELECT uses, max_uses FROM coupons WHERE code = $1", req.Code).
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
	if _, err := tx.Exec(ctx, "UPDATE coupons SET uses = uses + 1 WHERE code = $1", req.Code); err != nil {
		return serverError(err)
	}
	if _, err := tx.Exec(ctx, "INSERT INTO redemptions (code, user_id) VALUES ($1, $2)", req.Code, req.UserID); err != nil {
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
