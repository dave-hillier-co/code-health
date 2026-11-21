from ports.store import Store


class Service:
    def __init__(self, store: Store):
        self.store = store

    def find(self, key):
        return self.store.get(key)
