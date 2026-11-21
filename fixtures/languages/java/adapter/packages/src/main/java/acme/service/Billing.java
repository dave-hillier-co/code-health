package acme.service;

import acme.model.Account;

public class Billing {
    public static int charge(Account account) {
        return acme.model.Ledger.open().total() + account.balance();
    }
}
