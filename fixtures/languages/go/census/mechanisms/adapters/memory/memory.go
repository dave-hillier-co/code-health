package memory

import "example.com/census/ports"

type Memory struct {
	ports.Store
	data map[string]string
}

var handlers = map[string]ports.Handler{}

func NewMemory(store ports.Store) *Memory {
	return &Memory{Store: store, data: map[string]string{}}
}
