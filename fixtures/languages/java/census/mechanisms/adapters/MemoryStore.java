package adapters;

import ports.Store;

public class MemoryStore implements Store {
    public String get(String key) {
        return key;
    }
}
