package billing

import "example.com/shop/internal/tax"

// Invoice is an amount owed in a region.
type Invoice struct {
	amount int
	Region string
}

func NewInvoice(amount int) *Invoice {
	return &Invoice{amount: amount, Region: "eu"}
}

func (i *Invoice) Amount() int {
	return Total(i.amount, tax.Rate(i.Region))
}
