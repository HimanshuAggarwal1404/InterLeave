// Command bench measures how many requests per second the coupon victim app
// serves, to compare the app talking to Postgres directly with the app going
// through the RaceHound proxy (pass-through overhead, NFR-3).
//
// Usage: bench [flags] [URL ...]  (default URL: http://localhost:8081/redeem)
//
// It is a closed-loop load generator: each of --workers goroutines sends
// POST /redeem, waits for the response, and immediately sends the next one,
// for --duration. Each target gets a warmup round that is thrown away (it fills
// the app's connection pool and the HTTP keep-alive connections). Then --rounds
// measured rounds run, and in each round every target is measured once, in
// alternating order (A B, then B A, ...), so that a laptop slowing down as it
// heats up affects all targets alike. Use an even --rounds for a fair split.
//
// After seed.sql the coupon is single-use, so the first request redeems it and
// every measured request takes the "used up" path (409): BEGIN, SELECT,
// ROLLBACK. That is 3 round trips per request with no row locks, so requests do
// not queue behind each other and any extra latency from the proxy shows up.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"os/signal"
	"slices"
	"strings"
	"sync"
	"time"
)

type config struct {
	url      string
	code     string
	workers  int
	warmup   time.Duration
	duration time.Duration
	rounds   int
}

// roundResult is what one round measured. Each worker fills its own
// roundResult and they are merged after the round, so workers never share
// memory and need no locks.
type roundResult struct {
	requests  int
	errors    int // transport failures and 5xx responses
	firstErr  error
	statuses  map[int]int // HTTP status code -> count
	latencies []time.Duration
	elapsed   time.Duration
}

// target is one app URL being measured, with its own HTTP client so that
// switching targets does not close the other target's keep-alive connections.
type target struct {
	name   string // "A", "B", ...
	cfg    config // cfg.url is this target's URL
	client *http.Client
	rates  []float64
	errors int
}

func main() {
	os.Exit(run())
}

func run() int {
	var cfg config
	flag.StringVar(&cfg.code, "code", "DIWALI50", "coupon code to send")
	flag.IntVar(&cfg.workers, "workers", 16, "concurrent requests in flight")
	flag.DurationVar(&cfg.warmup, "warmup", 3*time.Second, "warmup length per target (not measured)")
	flag.DurationVar(&cfg.duration, "duration", 10*time.Second, "length of each measured round")
	flag.IntVar(&cfg.rounds, "rounds", 3, "number of measured rounds (each measures every target once)")
	flag.Usage = func() {
		fmt.Fprintln(os.Stderr, "usage: bench [flags] [URL ...]   (default URL http://localhost:8081/redeem)")
		flag.PrintDefaults()
	}
	flag.Parse()
	if cfg.workers < 1 || cfg.rounds < 1 || cfg.duration <= 0 {
		fmt.Fprintln(os.Stderr, "bench: --workers and --rounds must be >= 1 and --duration > 0")
		return 2
	}
	urls := flag.Args()
	if len(urls) == 0 {
		urls = []string{"http://localhost:8081/redeem"}
	}
	if len(urls) > 26 {
		fmt.Fprintln(os.Stderr, "bench: at most 26 URLs")
		return 2
	}

	// Ctrl+C cancels ctx: workers stop and we print whatever was measured.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	fmt.Printf("bench: %d workers, warmup %s, %d rounds x %s\n", cfg.workers, cfg.warmup, cfg.rounds, cfg.duration)
	targets := make([]*target, len(urls))
	for i, u := range urls {
		c := cfg
		c.url = u
		targets[i] = &target{name: string(rune('A' + i)), cfg: c, client: newClient(cfg.workers)}
		fmt.Printf("  %s = %s\n", targets[i].name, u)
	}

	// One request to each target up front, so a missing app fails fast with a
	// clear message instead of a round full of "connection refused".
	for _, tg := range targets {
		if status, err := send(ctx, tg.client, tg.cfg, 0); err != nil {
			fmt.Fprintf(os.Stderr, "bench: cannot reach the coupon app at %s: %v\n(is it running?)\n", tg.cfg.url, err)
			return 1
		} else if status >= 500 {
			fmt.Fprintf(os.Stderr, "bench: %s answered %d; check the app's terminal (is Postgres / the proxy up?)\n", tg.cfg.url, status)
			return 1
		}
	}

	if cfg.warmup > 0 {
		for _, tg := range targets {
			fmt.Printf("warmup   %s: %s\n", tg.name, runRound(ctx, tg.client, tg.cfg, cfg.warmup))
		}
	}
	for i := 1; i <= cfg.rounds && ctx.Err() == nil; i++ {
		for _, idx := range roundOrder(i, len(targets)) {
			tg := targets[idx]
			r := runRound(ctx, tg.client, tg.cfg, cfg.duration)
			if ctx.Err() != nil {
				break // cut short by Ctrl+C: do not count a partial round
			}
			fmt.Printf("round %-2d %s: %s\n", i, tg.name, r)
			if r.firstErr != nil {
				fmt.Printf("            first error: %v\n", r.firstErr)
			}
			tg.rates = append(tg.rates, r.rate())
			tg.errors += r.errors
		}
	}

	fmt.Println()
	totalErrors := 0
	for _, tg := range targets {
		if len(tg.rates) == 0 {
			fmt.Printf("result %s: no complete rounds\n", tg.name)
			return 1
		}
		fmt.Printf("result %s: median %.1f req/s (min %.1f, max %.1f) over %d rounds, %d errors\n",
			tg.name, median(tg.rates), slices.Min(tg.rates), slices.Max(tg.rates), len(tg.rates), tg.errors)
		totalErrors += tg.errors
	}
	for _, tg := range targets[1:] {
		a := median(targets[0].rates)
		fmt.Printf("%s vs A: %+.1f%% req/s (medians)\n", tg.name, (median(tg.rates)-a)/a*100)
	}
	if totalErrors > 0 {
		fmt.Println("WARNING: errors happened, so these numbers are not valid. Fix the setup and rerun.")
		return 1
	}
	return 0
}

// roundOrder returns the order in which to measure n targets in round
// (1-based): forwards in odd rounds, backwards in even ones.
func roundOrder(round, n int) []int {
	order := make([]int, n)
	for i := range order {
		order[i] = i
	}
	if round%2 == 0 {
		slices.Reverse(order)
	}
	return order
}

// newClient returns an HTTP client that keeps one connection per worker open.
// Go's default keeps only 2 idle connections per host, so with more workers it
// would open and close a TCP connection for most requests. That measures TCP
// setup instead of the app, and on Windows it can run out of local ports.
func newClient(workers int) *http.Client {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.MaxIdleConns = workers
	t.MaxIdleConnsPerHost = workers
	return &http.Client{Transport: t, Timeout: 30 * time.Second}
}

// runRound runs cfg.workers workers for d and merges what they measured.
// A worker only checks the deadline before starting a request, so requests in
// flight at the deadline finish normally and are counted; elapsed covers them.
func runRound(ctx context.Context, client *http.Client, cfg config, d time.Duration) roundResult {
	start := time.Now()
	deadline := start.Add(d)
	results := make([]roundResult, cfg.workers)

	var wg sync.WaitGroup
	for w := range cfg.workers {
		wg.Go(func() {
			res := &results[w] // only this goroutine touches results[w]
			res.statuses = map[int]int{}
			for ctx.Err() == nil && time.Now().Before(deadline) {
				t0 := time.Now()
				status, err := send(ctx, client, cfg, w+1)
				if errors.Is(err, context.Canceled) {
					return // Ctrl+C, not a failure of the app
				}
				res.latencies = append(res.latencies, time.Since(t0))
				res.requests++
				if err != nil || status >= 500 {
					res.errors++
					if res.firstErr == nil {
						if err == nil {
							err = fmt.Errorf("HTTP %d", status)
						}
						res.firstErr = err
					}
				}
				if err == nil {
					res.statuses[status]++
				}
			}
		})
	}
	wg.Wait()

	total := roundResult{statuses: map[int]int{}, elapsed: time.Since(start)}
	for _, r := range results {
		total.requests += r.requests
		total.errors += r.errors
		if total.firstErr == nil {
			total.firstErr = r.firstErr
		}
		for s, n := range r.statuses {
			total.statuses[s] += n
		}
		total.latencies = append(total.latencies, r.latencies...)
	}
	slices.Sort(total.latencies)
	return total
}

// send does one POST /redeem and returns the HTTP status code.
func send(ctx context.Context, client *http.Client, cfg config, userID int) (int, error) {
	body, err := json.Marshal(map[string]any{"code": cfg.code, "user_id": userID})
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.url, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	// Reading the body to the end lets the client reuse the connection.
	if _, err := io.Copy(io.Discard, resp.Body); err != nil {
		return 0, fmt.Errorf("reading response: %w", err)
	}
	return resp.StatusCode, nil
}

func (r roundResult) rate() float64 {
	if r.elapsed <= 0 {
		return 0
	}
	return float64(r.requests) / r.elapsed.Seconds()
}

func (r roundResult) String() string {
	codes := make([]int, 0, len(r.statuses))
	for s := range r.statuses {
		codes = append(codes, s)
	}
	slices.Sort(codes)
	var statuses strings.Builder
	for _, s := range codes {
		fmt.Fprintf(&statuses, " %d:%d", s, r.statuses[s])
	}
	return fmt.Sprintf("%7d requests in %5.2fs = %8.1f req/s  p50 %-9s p99 %-9s errors %d  [status%s]",
		r.requests, r.elapsed.Seconds(), r.rate(),
		percentile(r.latencies, 0.50).Round(time.Microsecond),
		percentile(r.latencies, 0.99).Round(time.Microsecond),
		r.errors, statuses.String())
}

// percentile returns the nearest-rank p-th percentile (0 < p <= 1) of an
// already sorted slice: the smallest value that at least p of the samples are
// less than or equal to.
func percentile(sorted []time.Duration, p float64) time.Duration {
	if len(sorted) == 0 {
		return 0
	}
	// The small epsilon stops float error (0.9*10 = 9.000000000000002) from
	// pushing the rank one too high.
	rank := int(math.Ceil(p*float64(len(sorted)) - 1e-9))
	return sorted[min(max(rank, 1), len(sorted))-1]
}

func median(xs []float64) float64 {
	s := slices.Clone(xs)
	slices.Sort(s)
	n := len(s)
	if n%2 == 1 {
		return s[n/2]
	}
	return (s[n/2-1] + s[n/2]) / 2
}
