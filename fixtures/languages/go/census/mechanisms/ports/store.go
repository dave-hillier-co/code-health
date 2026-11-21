package ports

type Store interface {
	Get(key string) (string, bool)
}

type Handler func(name string) error
