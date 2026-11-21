package billing

import "testing"

func TestAmount(t *testing.T) {
	invoice := NewInvoice(100)
	if invoice.Amount() != round(float64(100)*1.2) {
		t.Fatal("wrong amount")
	}
}
