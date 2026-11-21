from collections import defaultdict

plugin_registry = defaultdict(list)


class Plugins:
    def __init__(self):
        self.strategies: dict = {}

    def add(self, name, plugin):
        self.strategies[name] = plugin


def setup(registry):
    registry.register("a", 1)
