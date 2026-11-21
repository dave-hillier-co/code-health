// A unit forwards only when its whole body is one call whose arguments are its parameters or literals.
class Forwarding {
    int relay(int a) {
        return target(a);
    }

    int fixed(int a) {
        return target(a, 1);
    }

    int bare() {
        return target();
    }

    void statement(String s) {
        store.put(s);
    }

    int computed(int a) {
        return target(a + 1);
    }

    Wrapper creates(int a) {
        return new Wrapper(a);
    }

    int early(int a) {
        if (a < 0) {
            return 0;
        }
        return target(a);
    }
}
