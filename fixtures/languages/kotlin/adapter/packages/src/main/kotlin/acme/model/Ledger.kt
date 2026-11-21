package acme.model

class Ledger {
    private val account = Account()

    fun total(): Int = account.balance()
}

fun openLedger(): Ledger = Ledger()
