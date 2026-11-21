package billing_test

import (
	"testing"

	"example.com/shop/billing"
)

func TestNewInvoice(t *testing.T) {
	if billing.NewInvoice(5) == nil {
		t.Fatal("nil invoice")
	}
}
