package pgwire

import "testing"

func TestReadyStatus(t *testing.T) {
	tests := []struct {
		name    string
		msg     Message
		want    byte
		wantErr bool
	}{
		// 'Z' body: one status byte.
		{name: "idle", msg: Message{Type: 'Z', Body: []byte{'I'}}, want: 'I'},
		{name: "in transaction", msg: Message{Type: 'Z', Body: []byte{'T'}}, want: 'T'},
		{name: "failed transaction", msg: Message{Type: 'Z', Body: []byte{'E'}}, want: 'E'},
		{name: "not ReadyForQuery", msg: Message{Type: 'C', Body: []byte{'I'}}, wantErr: true},
		{name: "empty body", msg: Message{Type: 'Z', Body: []byte{}}, wantErr: true},
		{name: "two bytes", msg: Message{Type: 'Z', Body: []byte{'I', 'I'}}, wantErr: true},
		{name: "unknown status", msg: Message{Type: 'Z', Body: []byte{'X'}}, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ReadyStatus(tt.msg)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if got != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}
