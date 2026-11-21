package store

import "testing"

func TestOpen(t *testing.T) {
	if Open("db") != normalise("db") {
		t.Fatal("differs")
	}
}
