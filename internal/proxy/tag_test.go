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
		{name: "tagged", sql: "/* il:req=A */ SELECT 1", want: "A"},
		{name: "leading whitespace", sql: " \n\t/* il:req=B */ SELECT 1", want: "B"},
		{name: "no spaces inside comment", sql: "/*il:req=A*/SELECT 1", want: "A"},
		{name: "longer tag", sql: "/* il:req=req_2-b */ BEGIN", want: "req_2-b"},
		{name: "tag only", sql: "/* il:req=A */", want: "A"},
		{name: "64 characters", sql: "/* il:req=" + strings.Repeat("a", 64) + " */ SELECT 1", want: strings.Repeat("a", 64)},

		{name: "untagged", sql: "SELECT 1", want: ""},
		{name: "empty", sql: "", want: ""},
		{name: "other comment", sql: "/* healthcheck */ SELECT 1", want: ""},
		{name: "line comment", sql: "-- il:req=A\nSELECT 1", want: ""},
		// Only the start counts (D-015), so text inside a value cannot pose as a tag.
		{name: "tag later in query", sql: "SELECT '/* il:req=A */'", want: ""},
		{name: "tag after statement", sql: "SELECT 1 /* il:req=A */", want: ""},

		// Looks like our tag but is broken: an app bug worth reporting.
		{name: "empty tag", sql: "/* il:req= */ SELECT 1", wantErr: true},
		{name: "unterminated", sql: "/* il:req=A SELECT 1", wantErr: true},
		{name: "bad character", sql: "/* il:req=A;B */ SELECT 1", wantErr: true},
		{name: "space inside tag", sql: "/* il:req=A B */ SELECT 1", wantErr: true},
		{name: "too long", sql: "/* il:req=" + strings.Repeat("a", 65) + " */", wantErr: true},
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
