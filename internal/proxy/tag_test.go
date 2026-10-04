package proxy

import (
	"strings"
	"testing"
)

func TestRequestTag(t *testing.T) {
	tests := []struct {
		name    string
		sql     string
		want    string
		wantErr bool
	}{
		{name: "tagged", sql: "/* rh:req=A */ SELECT 1", want: "A"},
		{name: "leading whitespace", sql: " \n\t/* rh:req=B */ SELECT 1", want: "B"},
		{name: "no spaces inside comment", sql: "/*rh:req=A*/SELECT 1", want: "A"},
		{name: "longer tag", sql: "/* rh:req=req_2-b */ BEGIN", want: "req_2-b"},
		{name: "tag only", sql: "/* rh:req=A */", want: "A"},
		{name: "64 characters", sql: "/* rh:req=" + strings.Repeat("a", 64) + " */ SELECT 1", want: strings.Repeat("a", 64)},

		{name: "untagged", sql: "SELECT 1", want: ""},
		{name: "empty", sql: "", want: ""},
		{name: "other comment", sql: "/* healthcheck */ SELECT 1", want: ""},
		{name: "line comment", sql: "-- rh:req=A\nSELECT 1", want: ""},
		// Only the start counts (D-015), so text inside a value cannot pose as a tag.
		{name: "tag later in query", sql: "SELECT '/* rh:req=A */'", want: ""},
		{name: "tag after statement", sql: "SELECT 1 /* rh:req=A */", want: ""},

		// Looks like our tag but is broken: an app bug worth reporting.
		{name: "empty tag", sql: "/* rh:req= */ SELECT 1", wantErr: true},
		{name: "unterminated", sql: "/* rh:req=A SELECT 1", wantErr: true},
		{name: "bad character", sql: "/* rh:req=A;B */ SELECT 1", wantErr: true},
		{name: "space inside tag", sql: "/* rh:req=A B */ SELECT 1", wantErr: true},
		{name: "too long", sql: "/* rh:req=" + strings.Repeat("a", 65) + " */", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := requestTag(tt.sql)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if got != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}
