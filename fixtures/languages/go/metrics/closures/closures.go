package closures

import "sync"

func Run(jobs []func() error) error {
	var wg sync.WaitGroup
	var first error
	for _, job := range jobs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := job(); err != nil {
				first = err
			}
		}()
	}
	wg.Wait()
	return first
}

func Counter() func() int {
	count := 0
	next := func() int {
		count++
		if count > 3 {
			return 0
		}
		return count
	}
	return next
}
