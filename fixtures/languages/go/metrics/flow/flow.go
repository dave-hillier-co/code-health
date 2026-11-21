package flow

func Plain(a int) int {
	return a + 1
}

func Branches(a, b int) int {
	if a > 0 {
		return 1
	} else if b > 0 {
		return 2
	} else {
		return 3
	}
}

func Loops(xs []int) int {
	total := 0
	for i := 0; i < len(xs); i++ {
		total += xs[i]
	}
	for _, x := range xs {
		if x%2 == 0 {
			continue
		}
		total += x
	}
	for {
		break
	}
	return total
}

func Conditions(a, b, c bool) bool {
	if a && b || c {
		return true
	}
	return a && b && c
}

func Walk(n int) error {
	if err := Walk(n - 1); err != nil {
		return err
	}
	return nil
}
