package acme.service;

import acme.model.*;

public class Reports {
    public int run() {
        return Ledger.open().total();
    }
}
