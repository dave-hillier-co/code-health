package acme.model

class Ledger {
    private val account = Account()
}

fun openLedger(): Ledger = Ledger()
