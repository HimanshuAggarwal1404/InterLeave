// Command interleave finds race conditions in database-backed web apps.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"strings"

	"interleave/internal/proxy"
)

// Exit codes (docs/SPEC.md section 3).
const (
	exitOK       = 0
	exitUsage    = 2
	exitInternal = 3
)

const usage = `usage:
  interleave proxy [--listen localhost:6433] [--upstream localhost:5432] [--verbose]
      pass-through proxy, for debugging (Ctrl+C to stop); --verbose logs
      every query with its request tag`

func main() {
	os.Exit(run(os.Args[1:]))
}

// run executes one command and returns the process exit code.
func run(args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, usage)
		return exitUsage
	}
	switch args[0] {
	case "proxy":
		return runProxy(args[1:])
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n%s\n", args[0], usage)
		return exitUsage
	}
}

func runProxy(args []string) int {
	fs := flag.NewFlagSet("proxy", flag.ContinueOnError)
	listen := fs.String("listen", "localhost:6433", "address apps connect to (localhost only by default)")
	upstream := fs.String("upstream", "localhost:5432", "the local Postgres to forward to")
	verbose := fs.Bool("verbose", false, "log every query the app sends, with its request tag")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return exitOK
		}
		return exitUsage
	}

	p, err := proxy.New(*upstream)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return exitUsage
	}
	if *verbose {
		p.OnQuery = func(_ context.Context, tag, sql string) func(byte) {
			log.Print(queryLogLine(tag, sql))
			return nil
		}
	}
	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		fmt.Fprintf(os.Stderr, "cannot listen on %s: %v\n", *listen, err)
		return exitUsage
	}

	// ctx is cancelled on Ctrl+C, which makes Serve close everything and return.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	log.Printf("interleave proxy: %s -> %s (Ctrl+C to stop)", ln.Addr(), *upstream)
	if err := p.Serve(ctx, ln); err != nil {
		log.Printf("interleave proxy: %v", err)
		return exitInternal
	}
	log.Print("interleave proxy: stopped")
	return exitOK
}

// queryLogLine formats one query for --verbose: its tag ("-" if untagged)
// and its SQL on one line.
func queryLogLine(tag, sql string) string {
	if tag == "" {
		tag = "-"
	}
	return fmt.Sprintf("query [%s] %s", tag, strings.Join(strings.Fields(sql), " "))
}
