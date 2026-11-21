package store

func Open(name string) string {
	return normalise(name)
}

func normalise(name string) string {
	return name
}
