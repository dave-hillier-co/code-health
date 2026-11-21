package greet

func Hello(name string) string {
	return prefix() + name
}

func prefix() string {
	return "hello, "
}
