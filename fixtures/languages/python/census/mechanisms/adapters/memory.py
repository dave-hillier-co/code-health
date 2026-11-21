from ports.store import Store


class MemoryStore(Store):
    def get(self, key):
        return key
