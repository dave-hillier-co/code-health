package main

import (
	"net/http"

	"example.com/census/adapters/memory"
)

func main() {
	store := memory.NewMemory(nil)
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {})
	_ = store
}
