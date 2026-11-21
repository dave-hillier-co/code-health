package tax

const Default = 0.2

func Rate(region string) float64 {
	if region == "eu" {
		return Default
	}
	return 0
}
