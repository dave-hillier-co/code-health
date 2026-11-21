package acme.service;

import acme.model.Account;
import acme.model.Ledger;

public class Billing {
    public static void charge(Account account) {
        Ledger ledger = Ledger.open();
    }
}
