package main

import (
	"fmt"

	"example.com/m/billing"
)

func main() {
	fmt.Println(billing.Total([]billing.Invoice{billing.NewInvoice(5)}))
}
