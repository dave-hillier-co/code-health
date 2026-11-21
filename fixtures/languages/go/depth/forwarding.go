package depth

func Save(key string, value int) error {
	return store.Save(key, value)
}

func Total(price int, count int) int {
	return price * count
}

func Spread(prefix string, rest ...string) {
	logger.Log(prefix, rest...)
}

func Fixed(id int) error {
	return store.Delete(id, "now", 3)
}

func Created(id int) error {
	return store.Delete(NewKey(id))
}

type Counter struct {
	n    int
	Name string
}

func (c *Counter) Inc() { c.n++ }
