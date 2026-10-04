package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"slices"
	"sync/atomic"
	"testing"
	"time"
)

// TestRunRoundCountsEveryResponse checks that a round counts each request it
// sends exactly once, by status code, and that 409 (coupon used up) is not an
// error.
func TestRunRoundCountsEveryResponse(t *testing.T) {
	var served atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		served.Add(1)
		w.WriteHeader(http.StatusConflict)
	}))
	defer srv.Close()

	cfg := config{url: srv.URL + "/redeem", code: "DIWALI50", workers: 4}
	res := runRound(context.Background(), newClient(cfg.workers), cfg, 100*time.Millisecond)

	if res.requests == 0 {
		t.Fatal("round sent no requests")
	}
	if int64(res.requests) != served.Load() {
		t.Errorf("counted %d requests, server saw %d", res.requests, served.Load())
	}
	if res.statuses[http.StatusConflict] != res.requests {
		t.Errorf("statuses = %v, want all %d as 409", res.statuses, res.requests)
	}
	if res.errors != 0 {
		t.Errorf("errors = %d, want 0 (first: %v)", res.errors, res.firstErr)
	}
	if len(res.latencies) != res.requests {
		t.Errorf("%d latencies for %d requests", len(res.latencies), res.requests)
	}
}

// TestRunRoundCounts5xxAsErrors checks that server errors are reported, so a
// broken setup cannot produce a good-looking req/s number.
func TestRunRoundCounts5xxAsErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "internal error", http.StatusInternalServerError)
	}))
	defer srv.Close()

	cfg := config{url: srv.URL + "/redeem", code: "DIWALI50", workers: 2}
	res := runRound(context.Background(), newClient(cfg.workers), cfg, 50*time.Millisecond)

	if res.errors == 0 || res.errors != res.requests {
		t.Errorf("errors = %d, requests = %d, want every request to be an error", res.errors, res.requests)
	}
}

func TestPercentile(t *testing.T) {
	ms := func(n int) time.Duration { return time.Duration(n) * time.Millisecond }
	sorted := []time.Duration{ms(1), ms(2), ms(3), ms(4), ms(5), ms(6), ms(7), ms(8), ms(9), ms(10)}
	tests := []struct {
		p    float64
		want time.Duration
	}{
		{0.50, ms(5)},
		{0.90, ms(9)},
		{0.99, ms(10)},
		{1.00, ms(10)},
	}
	for _, tt := range tests {
		if got := percentile(sorted, tt.p); got != tt.want {
			t.Errorf("percentile(%v) = %v, want %v", tt.p, got, tt.want)
		}
	}
	if got := percentile(nil, 0.5); got != 0 {
		t.Errorf("percentile of empty = %v, want 0", got)
	}
}

// Rounds alternate A B, B A, A B, ... so that a laptop slowing down as it
// heats up does not always favour the target that goes first.
func TestRoundOrder(t *testing.T) {
	tests := []struct {
		round, targets int
		want           []int
	}{
		{1, 1, []int{0}},
		{2, 1, []int{0}},
		{1, 2, []int{0, 1}},
		{2, 2, []int{1, 0}},
		{3, 2, []int{0, 1}},
		{4, 3, []int{2, 1, 0}},
	}
	for _, tt := range tests {
		if got := roundOrder(tt.round, tt.targets); !slices.Equal(got, tt.want) {
			t.Errorf("roundOrder(%d, %d) = %v, want %v", tt.round, tt.targets, got, tt.want)
		}
	}
}

func TestMedian(t *testing.T) {
	tests := []struct {
		in   []float64
		want float64
	}{
		{[]float64{3, 1, 2}, 2},
		{[]float64{4, 1, 3, 2}, 2.5},
		{[]float64{7}, 7},
	}
	for _, tt := range tests {
		if got := median(tt.in); got != tt.want {
			t.Errorf("median(%v) = %v, want %v", tt.in, got, tt.want)
		}
	}
}
