package main

import "testing"

func TestRunUsageErrors(t *testing.T) {
	tests := []struct {
		name string
		args []string
	}{
		{"no command", nil},
		{"unknown command", []string{"explode"}},
		{"unknown flag", []string{"proxy", "--nope"}},
		{"remote upstream refused", []string{"proxy", "--upstream", "db.example.com:5432"}},
		{"bad listen address", []string{"proxy", "--listen", "not-an-address"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if code := run(tt.args); code != 2 {
				t.Errorf("run(%q) = %d, want 2 (usage or configuration error)", tt.args, code)
			}
		})
	}
}

func TestQueryLogLine(t *testing.T) {
	tests := []struct {
		tag, sql, want string
	}{
		{"A", "/* rh:req=A */ SELECT 1", "query [A] /* rh:req=A */ SELECT 1"},
		{"", "begin", "query [-] begin"},
		{"B", "/* rh:req=B */ SELECT 1\n  FROM t", "query [B] /* rh:req=B */ SELECT 1 FROM t"},
	}
	for _, tt := range tests {
		if got := queryLogLine(tt.tag, tt.sql); got != tt.want {
			t.Errorf("queryLogLine(%q, %q) = %q, want %q", tt.tag, tt.sql, got, tt.want)
		}
	}
}
