package acme.service

import acme.model.*

fun total(): Int = openLedger().hashCode()
