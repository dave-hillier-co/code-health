package awkward

import "strings"

// Join has a signature over several lines.
func Join(
	prefix string,
	parts []string,
) string {
	return prefix + strings.Join(parts, ",")
}

func Map[T, U any](items []T, convert func(T) U) []U {
	out := make([]U, 0, len(items))
	for _, item := range items {
		out = append(out, convert(item))
	}
	return out
}

type Stack[T any] struct {
	items []T
}

func (s *Stack[T]) Push(item T) {
	s.items = append(s.items, item)
}

func (s *Stack[T]) Pop() (T, bool) {
	var zero T
	if len(s.items) == 0 {
		return zero, false
	}
	last := s.items[len(s.items)-1]
	s.items = s.items[:len(s.items)-1]
	return last, true
}

func Braces() string {
	// a comment with a brace {
	text := "not a block {"
	raw := `
	func fake() {
	}
	`
	return text + raw + string('}')
}

var handlers = map[string]func(int) int{
	"double": func(n int) int { return n * 2 },
}

func Apply(name string, n int) int {
	if handler, ok := handlers[name]; ok {
		return handler(n)
	}
	return n
}

func Inline() {
	sort := func(xs []int) {
		for i := range xs {
			_ = i
		}
	}
	sort(nil)
}

func (s Stack[T]) Len() int { return len(s.items) }

func Spawn(work func()) {
	go func() {
		defer func() { _ = recover() }()
		work()
	}()
}
