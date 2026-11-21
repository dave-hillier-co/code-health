package acme.service

import acme.model.Account
import acme.model.openLedger as open

fun charge(account: Account): Int = open().hashCode()
