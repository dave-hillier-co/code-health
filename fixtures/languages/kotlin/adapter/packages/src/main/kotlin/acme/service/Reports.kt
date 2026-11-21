package acme.service

import acme.model.*

class Reports {
    fun run(): Int = openLedger().total()
}
