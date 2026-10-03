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
