//go:build sched

// These tests are the spec for sched v1 (Phase 1): park tagged steps and
// release them in a hard-coded order. They are written before the code, so
// they only build with the "sched" tag until the package exists:
//
//	go test -race -tags sched ./internal/sched
//
// Remove the build line above once sched.go is written and they pass.
package sched

import (
	"context"
	"errors"
	"slices"
	"sync"
	"testing"
	"time"
)

// fakeRequest plays one request through the scheduler, the way the proxy
// would: for each statement it calls OnQuery (blocking while the step is
// parked), records that the statement now runs, then reports it finished.
func fakeRequest(ctx context.Context, s *Scheduler, tag string, sqls []string, ran chan<- string) {
	for _, sql := range sqls {
		done := s.OnQuery(ctx, tag, sql)
		ran <- tag + " " + sql
		if done != nil {
			done('T')
		}
	}
}

// startRun runs s.Run in a goroutine and returns a channel with its result.
func startRun(ctx context.Context, s *Scheduler) <-chan runResult {
	res := make(chan runResult, 1)
	go func() {
		trace, err := s.Run(ctx)
		res <- runResult{trace, err}
	}()
	return res
}

type runResult struct {
	trace []Step
	err   error
}

func TestReleasesStepsInTheGivenOrder(t *testing.T) {
	reqs := map[string][]string{
		"A": {"a1", "a2", "a3"},
		"B": {"b1", "b2"},
	}
	tests := []struct {
		name  string
		order []string
		want  []string
	}{
		{"A then B", []string{"A", "A", "A", "B", "B"}, []string{"A a1", "A a2", "A a3", "B b1", "B b2"}},
		{"B then A", []string{"B", "B", "A", "A", "A"}, []string{"B b1", "B b2", "A a1", "A a2", "A a3"}},
		{"interleaved", []string{"A", "B", "B", "A", "A"}, []string{"A a1", "B b1", "B b2", "A a2", "A a3"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			s := New(tt.order)
			run := startRun(ctx, s)

			ran := make(chan string, 10)
			var wg sync.WaitGroup
			for tag, sqls := range reqs {
				wg.Go(func() { fakeRequest(ctx, s, tag, sqls, ran) })
			}
			wg.Wait()
			close(ran)
			var got []string
			for r := range ran {
				got = append(got, r)
			}
			if !slices.Equal(got, tt.want) {
				t.Errorf("statements ran in order %q, want %q", got, tt.want)
			}

			res := receive(t, run, "Run did not return after the last step finished")
			if res.err != nil {
				t.Fatalf("Run returned error %v", res.err)
			}
			var trace []string
			for _, st := range res.trace {
				trace = append(trace, st.Tag+" "+st.SQL)
				if st.Status != 'T' {
					t.Errorf("step %q has status %q, want the one done reported ('T')", st.SQL, st.Status)
				}
			}
			if !slices.Equal(trace, tt.want) {
				t.Errorf("Run's trace %q, want %q", trace, tt.want)
			}
		})
	}
}

// The next step is released only after the previous one has finished (its
// done was called), so two steps never run at the same time.
func TestNextStepWaitsForDone(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s := New([]string{"A", "B"})
	startRun(ctx, s)

	aDone := make(chan func(byte), 1)
	go func() { aDone <- s.OnQuery(ctx, "A", "a1") }()
	doneA := receive(t, aDone, "A's step was never released")

	bReleased := make(chan func(byte), 1)
	go func() { bReleased <- s.OnQuery(ctx, "B", "b1") }()
	notWithin(t, bReleased, "B was released while A's step was still running")

	doneA('T')
	receive(t, bReleased, "B was not released after A's step finished")
}

// A step of a request that is not next in the order stays parked, even if it
// arrives first.
func TestWaitsForTheRequestWhoseTurnItIs(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s := New([]string{"B", "A"})
	startRun(ctx, s)

	aReleased := make(chan func(byte), 1)
	go func() { aReleased <- s.OnQuery(ctx, "A", "a1") }()
	notWithin(t, aReleased, "A was released although the order starts with B")

	bReleased := make(chan func(byte), 1)
	go func() { bReleased <- s.OnQuery(ctx, "B", "b1") }()
	doneB := receive(t, bReleased, "B was never released")
	notWithin(t, aReleased, "A was released while B's step was still running")
	doneB('I')
	receive(t, aReleased, "A was not released after B finished")
}

// Untagged statements (pgx's ROLLBACK, health checks; D-016) and tags the
// order never mentions are not scheduled: OnQuery returns at once, with no
// done, even before Run starts.
func TestUnscheduledQueriesPassThrough(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s := New([]string{"A"})
	for _, tag := range []string{"", "C"} {
		got := make(chan func(byte), 1)
		go func() { got <- s.OnQuery(ctx, tag, "ROLLBACK") }()
		if done := receive(t, got, "OnQuery blocked for tag "+tag); done != nil {
			t.Errorf("tag %q: OnQuery returned a done func, want nil (not scheduled)", tag)
		}
	}
}

// Once the order is used up, Run returns and later steps run freely.
func TestAfterTheOrderEverythingPassesThrough(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s := New([]string{"A"})
	run := startRun(ctx, s)

	ran := make(chan string, 1)
	fakeRequest(ctx, s, "A", []string{"a1"}, ran)
	if res := receive(t, run, "Run did not return after the order was used up"); res.err != nil {
		t.Fatalf("Run returned error %v", res.err)
	}

	got := make(chan func(byte), 1)
	go func() { got <- s.OnQuery(ctx, "A", "a2") }()
	receive(t, got, "a step after the order was used up blocked")
}

// A parked step whose connection goes away (the proxy cancels OnQuery's ctx)
// must give up instead of waiting forever.
func TestCancelledStepGivesUp(t *testing.T) {
	s := New([]string{"A"}) // Run never starts, so nothing is ever released
	ctx, cancel := context.WithCancel(context.Background())
	got := make(chan func(byte), 1)
	go func() { got <- s.OnQuery(ctx, "A", "a1") }()
	notWithin(t, got, "OnQuery returned although nothing released it")
	cancel()
	receive(t, got, "OnQuery did not return after its ctx was cancelled")
}

// Cancelling Run (run timeout, Ctrl+C) returns the trace so far with the
// ctx error, and un-parks every waiting step so no proxy goroutine is stuck.
func TestCancelledRunReleasesParkedSteps(t *testing.T) {
	runCtx, cancelRun := context.WithCancel(context.Background())
	s := New([]string{"A", "B"}) // A never comes, so B waits forever
	run := startRun(runCtx, s)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	bGot := make(chan func(byte), 1)
	go func() { bGot <- s.OnQuery(ctx, "B", "b1") }()
	notWithin(t, bGot, "B was released before A")

	cancelRun()
	res := receive(t, run, "Run did not return after its ctx was cancelled")
	if !errors.Is(res.err, context.Canceled) {
		t.Errorf("Run returned %v, want context.Canceled", res.err)
	}
	if len(res.trace) != 0 {
		t.Errorf("trace = %v, want empty (nothing ran)", res.trace)
	}
	receive(t, bGot, "B's OnQuery stayed blocked after Run returned")
}

// receive waits up to 5s for a value; a missing value fails the test.
func receive[T any](t *testing.T, ch <-chan T, failMsg string) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(5 * time.Second):
		t.Fatal(failMsg)
		var zero T
		return zero
	}
}

// notWithin checks that nothing arrives on ch for a short while. It can only
// catch a wrong release that happens quickly, which is how a scheduler bug
// shows up here; it never makes a correct scheduler fail.
func notWithin[T any](t *testing.T, ch <-chan T, failMsg string) {
	t.Helper()
	select {
	case <-ch:
		t.Fatal(failMsg)
	case <-time.After(150 * time.Millisecond):
	}
}
