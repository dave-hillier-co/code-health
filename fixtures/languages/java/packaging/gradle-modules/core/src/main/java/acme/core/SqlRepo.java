package acme.core;

public class SqlRepo implements Repo {
    public String find(String id) {
        return new Hidden().wrap(id);
    }
}
