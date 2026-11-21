package acme;

import static acme.service.Billing.charge;

public class Main {
    Account hidden;
    Reports unseen;

    public static void main(String[] args) {
        charge(null);
    }
}
