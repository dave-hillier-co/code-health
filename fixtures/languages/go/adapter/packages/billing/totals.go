package billing

func Total(amount int, rate float64) int {
	return round(float64(amount) * (1 + rate))
}

func round(value float64) int {
	return int(value + 0.5)
}
