package main

import (
	"fmt"

	"example.com/shop/billing"
	"example.com/shop/internal/tax"
)

func main() {
	invoice := billing.NewInvoice(100)
	fmt.Println(invoice.Amount(), tax.Rate(invoice.Region))
}
