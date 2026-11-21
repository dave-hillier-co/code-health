package acme.model;

public class Ledger {
    private final Account account = new Account();

    public static Ledger open() {
        return new Ledger();
    }
}
