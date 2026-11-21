package shop

// Cart holds items. { not a block
type Cart struct {
	items []int
}

func (c *Cart) Total(limit int) (int, error) {
	/* block { comment */
	sum := 0
	for _, item := range c.items {
		if item > 0 && item < limit {
			sum += item
		}
	}
	raw := `a "quote" and { brace`
	brace := '{'
	_, _ = raw, brace
	if sum > limit {
		return 0, errors.New("over")
	}
	return sum, nil
}

func Double(x int) int { return x * 2 }

func Run(jobs chan int) {
	go func() {
		select {
		case j := <-jobs:
			_ = j
		default:
		}
	}()
}
