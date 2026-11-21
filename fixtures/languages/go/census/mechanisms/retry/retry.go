package retry

func Retry(attempts int, op func() error) error {
	var err error
	for i := 0; i < attempts; i++ {
		if err = op(); err == nil {
			return nil
		}
	}
	return err
}
