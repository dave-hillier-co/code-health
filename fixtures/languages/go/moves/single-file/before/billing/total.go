package billing

func Total(invoices []Invoice) int {
	sum := 0
	for _, invoice := range invoices {
		sum += invoice.Amount
	}
	return sum
}
