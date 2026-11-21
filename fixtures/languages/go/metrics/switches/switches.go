package switches

func Kind(v interface{}) string {
	switch t := v.(type) {
	case int:
		return "int"
	case string, bool:
		return "text or flag"
	default:
		_ = t
		return "other"
	}
}

func Pick(n int) string {
	switch {
	case n < 0:
		return "negative"
	case n == 0:
		return "zero"
	}
	switch n {
	case 1, 2, 3:
		return "small"
	default:
		return "large"
	}
}

func Wait(a, b <-chan int, done chan struct{}) int {
	select {
	case v := <-a:
		return v
	case v, ok := <-b:
		if ok {
			return v
		}
	case <-done:
	default:
	}
	return 0
}
