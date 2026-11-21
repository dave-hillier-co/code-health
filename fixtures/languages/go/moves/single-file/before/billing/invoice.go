package billing

type Invoice struct {
	Amount int
}

func NewInvoice(amount int) Invoice {
	return Invoice{Amount: amount}
}
