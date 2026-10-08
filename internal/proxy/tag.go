package proxy

import (
	"fmt"
	"strings"
)

const maxTagLen = 64

// requestTag returns the request tag of a query that starts with the comment
// /* il:req=<tag> */ (leading whitespace allowed). Only the start of the query
// counts (D-015): the same text inside a string value must not pose as a tag.
// It returns "" and no error for an untagged query, and an error when the
// query starts with our comment but the comment is broken (an app bug).
func requestTag(sql string) (string, error) {
	rest, ok := strings.CutPrefix(strings.TrimLeft(sql, " \t\r\n"), "/*")
	if !ok {
		return "", nil
	}
	rest, ok = strings.CutPrefix(strings.TrimLeft(rest, " "), "il:req=")
	if !ok {
		return "", nil // some other comment
	}
	tag, _, ok := strings.Cut(rest, "*/")
	if !ok {
		return "", fmt.Errorf("request tag comment is not closed: %.60q", sql)
	}
	tag = strings.TrimRight(tag, " ")
	if !validTag(tag) {
		return "", fmt.Errorf("invalid request tag %.70q: want 1-%d of A-Z a-z 0-9 _ -", tag, maxTagLen)
	}
	return tag, nil
}

func validTag(tag string) bool {
	if len(tag) == 0 || len(tag) > maxTagLen {
		return false
	}
	for _, c := range []byte(tag) {
		ok := c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_' || c == '-'
		if !ok {
			return false
		}
	}
	return true
}
