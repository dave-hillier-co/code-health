package app;

import ports.Store;

@Service
public class Service {
    private final Store store;

    public Service(Store store) {
        this.store = store;
    }
}
