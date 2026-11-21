package core

type Store interface {
	Get(key string) string
}

type Memory struct {
	items map[string]string
}

type Level int

type item struct{ key string }

func NewMemory() *Memory {
	return &Memory{items: map[string]string{}}
}

func (m *Memory) Get(key string) string {
	return m.items[key]
}

func helper() item {
	return item{}
}
