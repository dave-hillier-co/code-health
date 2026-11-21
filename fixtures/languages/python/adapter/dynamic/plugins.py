import importlib


def load(name):
    importlib.import_module("plugin_a")
    return importlib.import_module(name)
