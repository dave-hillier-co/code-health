package labels

func Find(grid [][]int, want int) (int, int) {
outer:
	for r, row := range grid {
		for c, cell := range row {
			if cell == want {
				return r, c
			}
			if cell < 0 {
				continue outer
			}
			if cell > 100 {
				break outer
			}
		}
	}
	return -1, -1
}

func Retry(attempts int) error {
	var err error
retry:
	err = try()
	if err != nil && attempts > 0 {
		attempts--
		goto retry
	}
	return err
}
