// Command racehound finds race conditions in database-backed web apps.
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

	"racehound/internal/proxy"
)

// Exit codes (docs/SPEC.md section 3).
const (
	exitOK       = 0
	exitUsage    = 2
	exitInternal = 3
)

const usage = `usage:
  racehound proxy [--listen localhost:6433] [--upstream localhost:5432]
      pass-through proxy, for debugging (Ctrl+C to stop)`

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
	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		fmt.Fprintf(os.Stderr, "cannot listen on %s: %v\n", *listen, err)
		return exitUsage
	}

	// ctx is cancelled on Ctrl+C, which makes Serve close everything and return.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	log.Printf("racehound proxy: %s -> %s (Ctrl+C to stop)", ln.Addr(), *upstream)
	if err := p.Serve(ctx, ln); err != nil {
		log.Printf("racehound proxy: %v", err)
		return exitInternal
	}
	log.Print("racehound proxy: stopped")
	return exitOK
}
