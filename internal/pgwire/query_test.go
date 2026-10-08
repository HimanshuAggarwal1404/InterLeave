package pgwire

import "testing"

func TestQueryString(t *testing.T) {
	tests := []struct {
		name    string
		msg     Message
		want    string
		wantErr bool
	}{
		{
			// 'Q' body: the SQL text, then one NUL byte.
			name: "simple query",
			msg:  Message{Type: 'Q', Body: []byte("SELECT 1\x00")},
			want: "SELECT 1",
		},
		{
			name: "tagged query",
			msg:  Message{Type: 'Q', Body: []byte("/* il:req=A */ SELECT 1\x00")},
			want: "/* il:req=A */ SELECT 1",
		},
		{
			// An empty query string is legal: Postgres answers EmptyQueryResponse.
			name: "empty query",
			msg:  Message{Type: 'Q', Body: []byte{0x00}},
			want: "",
		},
		{name: "not a Query", msg: Message{Type: 'X', Body: []byte{}}, wantErr: true},
		{name: "missing NUL", msg: Message{Type: 'Q', Body: []byte("SELECT 1")}, wantErr: true},
		{name: "empty body", msg: Message{Type: 'Q', Body: []byte{}}, wantErr: true},
		{name: "bytes after NUL", msg: Message{Type: 'Q', Body: []byte("SELECT 1\x00x\x00")}, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := QueryString(tt.msg)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if got != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}
