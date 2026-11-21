package recur

type Tree struct {
	Left, Right *Tree
	Value       int
}

func (t *Tree) Sum() int {
	if t == nil {
		return 0
	}
	return t.Value + t.Left.Sum() + t.Right.Sum()
}

func (t *Tree) Retry(n int) int {
	if n == 0 {
		return t.Value
	}
	return t.Retry(n - 1)
}

func Fact(n int) int {
	if n <= 1 {
		return 1
	}
	return n * Fact(n-1)
}

func Variadic(prefix string, parts ...string) string {
	return prefix + parts[0]
}

func Unnamed(int, string) {}
