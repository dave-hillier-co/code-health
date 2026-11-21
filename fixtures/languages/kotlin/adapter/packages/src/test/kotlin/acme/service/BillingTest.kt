package acme.service

import acme.model.Account

class BillingTest {
    fun run(account: Account): Int = charge(account)
}
