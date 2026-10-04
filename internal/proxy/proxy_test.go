package proxy

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"racehound/internal/pgwire"
)

// Byte fixtures. Same encodings as the pgwire tests (see there for captures).
var (
	sslRequest = []byte{0x00, 0x00, 0x00, 0x08, 0x04, 0xd2, 0x16, 0x2f}
	// StartupMessage, protocol 3.0: user=racehound database=racehound.
	startupMsg = []byte("\x00\x00\x00\x2b\x00\x03\x00\x00" +
		"user\x00racehound\x00database\x00racehound\x00\x00")
	// CancelRequest for PID 4242 with a 4-byte secret key.
	cancelRequest = []byte{0x00, 0x00, 0x00, 0x10, 0x04, 0xd2, 0x16, 0x2e, 0x00, 0x00, 0x10, 0x92, 0xde, 0xad, 0xbe, 0xef}
	// 'R' AuthenticationOk (len 8, code 0), then 'Z' ReadyForQuery idle.
	authOKReady = []byte{'R', 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 'Z', 0x00, 0x00, 0x00, 0x05, 'I'}
	// 'Q' Query "SELECT 1".
	query = append([]byte{'Q', 0x00, 0x00, 0x00, 0x0d}, "SELECT 1\x00"...)
	// 'X' Terminate.
	terminate = []byte{'X', 0x00, 0x00, 0x00, 0x04}
)

func TestNewOnlyAllowsLocalUpstream(t *testing.T) {
	tests := []struct {
		upstream string
		ok       bool
	}{
		{"localhost:5432", true},
		{"127.0.0.1:5432", true},
		{"[::1]:5432", true},
		{"db.example.com:5432", false},
		{"10.0.0.5:5432", false},
		{":5432", false},     // empty host: say "localhost" explicitly
		{"localhost", false}, // no port
	}
	for _, tt := range tests {
		t.Run(tt.upstream, func(t *testing.T) {
			_, err := New(tt.upstream)
			if tt.ok && err != nil {
				t.Errorf("New(%q) = %v, want ok", tt.upstream, err)
			}
			if !tt.ok && err == nil {
				t.Errorf("New(%q) succeeded, want error", tt.upstream)
			}
		})
	}
}

// Full conversation against a fake Postgres, checking every byte the proxy forwards.
func TestPassThroughFakeUpstream(t *testing.T) {
	upstreamAddr, accepted := fakeUpstream(t)
	client := dial(t, startProxy(t, upstreamAddr))

	// SSLRequest is answered by the proxy itself with 'N'; Postgres never sees it.
	write(t, client, sslRequest)
	expectBytes(t, client, []byte{'N'})

	// The StartupMessage is forwarded unchanged.
	write(t, client, startupMsg)
	server := acceptOne(t, accepted)
	got, err := pgwire.ReadStartup(server)
	if err != nil {
		t.Fatalf("upstream reading startup: %v", err)
	}
	if !bytes.Equal(got.Raw, startupMsg) {
		t.Fatalf("upstream got startup % x, want % x", got.Raw, startupMsg)
	}

	// Postgres → app.
	write(t, server, authOKReady)
	expectBytes(t, client, authOKReady)

	// App → Postgres.
	write(t, client, query)
	expectBytes(t, server, query)

	// App says goodbye and hangs up: Postgres sees Terminate, then the proxy closes it too.
	write(t, client, terminate)
	client.Close()
	expectBytes(t, server, terminate)
	expectEOF(t, server)
}

// OnQuery sees every Query with its request tag, before the query is
// forwarded, and the query still reaches Postgres byte for byte.
func TestOnQueryReportsTags(t *testing.T) {
	type seen struct{ tag, sql string }
	queries := make(chan seen, 10)
	upstreamAddr, accepted := fakeUpstream(t)
	p, err := New(upstreamAddr)
	if err != nil {
		t.Fatal(err)
	}
	p.OnQuery = func(tag, sql string) { queries <- seen{tag, sql} }
	client := dial(t, serveProxy(t, p))

	write(t, client, startupMsg)
	server := acceptOne(t, accepted)
	if _, err := pgwire.ReadStartup(server); err != nil {
		t.Fatalf("upstream reading startup: %v", err)
	}
	write(t, server, authOKReady)
	expectBytes(t, client, authOKReady)

	tests := []struct {
		raw  []byte
		want seen
	}{
		{queryMsg("/* rh:req=A */ SELECT 1"), seen{"A", "/* rh:req=A */ SELECT 1"}},
		{query, seen{"", "SELECT 1"}},
		// A broken tag is logged and treated as untagged; the query still goes through.
		{queryMsg("/* rh:req=A;B */ SELECT 1"), seen{"", "/* rh:req=A;B */ SELECT 1"}},
	}
	for _, tt := range tests {
		write(t, client, tt.raw)
		expectBytes(t, server, tt.raw)
		select {
		case got := <-queries:
			if got != tt.want {
				t.Errorf("OnQuery got %+v, want %+v", got, tt.want)
			}
		default:
			t.Errorf("OnQuery was not called before %q was forwarded", tt.want.sql)
		}
	}

	// Other messages (here Terminate) are not queries.
	write(t, client, terminate)
	expectBytes(t, server, terminate)
	select {
	case got := <-queries:
		t.Errorf("OnQuery called for a non-Query message: %+v", got)
	default:
	}
}

// queryMsg builds a 'Q' Query message: type, length (4 + text + NUL), text, NUL.
func queryMsg(sql string) []byte {
	n := 4 + len(sql) + 1
	return append([]byte{'Q', byte(n >> 24), byte(n >> 16), byte(n >> 8), byte(n)}, sql+"\x00"...)
}

// If Postgres hangs up (e.g. it was restarted), the app's connection must close too.
func TestUpstreamCloseClosesClient(t *testing.T) {
	upstreamAddr, accepted := fakeUpstream(t)
	client := dial(t, startProxy(t, upstreamAddr))

	write(t, client, startupMsg)
	server := acceptOne(t, accepted)
	if _, err := pgwire.ReadStartup(server); err != nil {
		t.Fatalf("upstream reading startup: %v", err)
	}
	server.Close()
	expectEOF(t, client)
}

// A CancelRequest arrives on its own new connection: forward it, then hang up.
func TestCancelRequestForwarded(t *testing.T) {
	upstreamAddr, accepted := fakeUpstream(t)
	client := dial(t, startProxy(t, upstreamAddr))

	write(t, client, cancelRequest)
	server := acceptOne(t, accepted)
	expectBytes(t, server, cancelRequest)
	expectEOF(t, server)
	expectEOF(t, client)
}

// If Postgres is not reachable, the app's connection is closed rather than left hanging.
func TestUpstreamUnreachable(t *testing.T) {
	// Grab a free port, then close it so nothing is listening there.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	deadAddr := ln.Addr().String()
	ln.Close()

	client := dial(t, startProxy(t, deadAddr))
	write(t, client, startupMsg)
	expectEOF(t, client)
}

// Shutting the proxy down while an app is connected must close that connection
// and let Serve return (startProxy's cleanup fails the test if it does not).
func TestShutdownClosesOpenConnections(t *testing.T) {
	upstreamAddr, accepted := fakeUpstream(t)
	p, err := New(upstreamAddr)
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- p.Serve(ctx, ln) }()

	client := dial(t, ln.Addr().String())
	write(t, client, startupMsg)
	server := acceptOne(t, accepted)
	if _, err := pgwire.ReadStartup(server); err != nil {
		t.Fatalf("upstream reading startup: %v", err)
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("Serve returned %v, want nil after cancel", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Serve did not return within 5s of cancel")
	}
	expectEOF(t, client)
	expectEOF(t, server)
}

// The real thing: pgx talks to the local Postgres 18 through the proxy, with
// SCRAM authentication, several connections at once, and a transaction.
func TestRealPostgres(t *testing.T) {
	const upstream = "localhost:5432"
	if c, err := net.DialTimeout("tcp", upstream, time.Second); err != nil {
		t.Skipf("Postgres not reachable at %s, skipping: %v", upstream, err)
	} else {
		c.Close()
	}
	addr := startProxy(t, upstream)

	// "disable" skips the SSLRequest; "prefer" sends it and must get 'N' to continue.
	for _, sslmode := range []string{"disable", "prefer"} {
		t.Run("sslmode="+sslmode, func(t *testing.T) {
			ctx := context.Background()
			dsn := fmt.Sprintf("postgres://racehound:racehound@%s/racehound?sslmode=%s&default_query_exec_mode=simple_protocol&pool_max_conns=5&connect_timeout=5", addr, sslmode)
			pool, err := pgxpool.New(ctx, dsn)
			if err != nil {
				t.Fatalf("pgxpool.New: %v", err)
			}
			defer pool.Close()

			// 20 concurrent queries over up to 5 connections.
			var wg sync.WaitGroup
			for i := range 20 {
				wg.Go(func() {
					var db string
					var n int
					err := pool.QueryRow(ctx, "SELECT current_database(), $1::int + 1", i).Scan(&db, &n)
					if err != nil {
						t.Errorf("query %d: %v", i, err)
						return
					}
					if db != "racehound" || n != i+1 {
						t.Errorf("query %d = (%q, %d), want (racehound, %d)", i, db, n, i+1)
					}
				})
			}
			wg.Wait()

			// A transaction, like the coupon app's (temp table: nothing persists).
			err = pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
				if _, err := tx.Exec(ctx, "CREATE TEMP TABLE t (n int) ON COMMIT DROP"); err != nil {
					return err
				}
				if _, err := tx.Exec(ctx, "INSERT INTO t VALUES (1), (2)"); err != nil {
					return err
				}
				var sum int
				if err := tx.QueryRow(ctx, "SELECT sum(n) FROM t").Scan(&sum); err != nil {
					return err
				}
				if sum != 3 {
					return fmt.Errorf("sum = %d, want 3", sum)
				}
				return nil
			})
			if err != nil {
				t.Fatalf("transaction: %v", err)
			}
		})
	}
}

// startProxy runs a proxy in front of upstream on a random local port and
// returns its address. At test end it shuts the proxy down and fails the test
// if Serve does not return, which would mean a stuck or leaked goroutine.
func startProxy(t *testing.T, upstream string) string {
	t.Helper()
	p, err := New(upstream)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return serveProxy(t, p)
}

// serveProxy is startProxy for a proxy the test has already configured.
func serveProxy(t *testing.T, p *Proxy) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- p.Serve(ctx, ln) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("Serve: %v", err)
			}
		case <-time.After(5 * time.Second):
			t.Error("Serve did not return within 5s of cancel")
		}
	})
	return ln.Addr().String()
}

// fakeUpstream stands in for Postgres: it listens on a random local port and
// hands the first connection the proxy opens to the test.
func fakeUpstream(t *testing.T) (string, <-chan net.Conn) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() }) // also ends the Accept goroutine below
	accepted := make(chan net.Conn, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		accepted <- c
	}()
	return ln.Addr().String(), accepted
}

func acceptOne(t *testing.T, accepted <-chan net.Conn) net.Conn {
	t.Helper()
	select {
	case c := <-accepted:
		t.Cleanup(func() { c.Close() })
		withDeadline(c)
		return c
	case <-time.After(5 * time.Second):
		t.Fatal("proxy never connected upstream")
		return nil
	}
}

func dial(t *testing.T, addr string) net.Conn {
	t.Helper()
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatalf("dial proxy: %v", err)
	}
	t.Cleanup(func() { c.Close() })
	withDeadline(c)
	return c
}

// withDeadline makes every read and write on c fail after 5s instead of
// hanging the test forever if the proxy misbehaves.
func withDeadline(c net.Conn) {
	c.SetDeadline(time.Now().Add(5 * time.Second))
}

func write(t *testing.T, c net.Conn, b []byte) {
	t.Helper()
	if _, err := c.Write(b); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func expectBytes(t *testing.T, c net.Conn, want []byte) {
	t.Helper()
	got := make([]byte, len(want))
	if _, err := io.ReadFull(c, got); err != nil {
		t.Fatalf("reading %d bytes: %v", len(want), err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("got % x, want % x", got, want)
	}
}

// expectEOF checks that the other side closed the connection.
func expectEOF(t *testing.T, c net.Conn) {
	t.Helper()
	b := make([]byte, 1)
	n, err := c.Read(b)
	if n > 0 {
		t.Fatalf("got unexpected byte %q, want connection closed", b[0])
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		t.Fatal("connection still open after 5s, want it closed")
	}
	if err == nil {
		t.Fatal("read succeeded, want connection closed")
	}
	// io.EOF, or a "connection reset" on Windows: both mean the proxy closed it.
}
