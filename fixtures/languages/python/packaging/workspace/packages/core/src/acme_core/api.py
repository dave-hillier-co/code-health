from abc import ABC, abstractmethod
from typing import Protocol


class Repository(ABC):
    @abstractmethod
    def load(self): ...


class Store(Protocol):
    def save(self, item): ...


class Greeter:
    def greet(self):
        return "hi"


class Plain:
    pass


def normalise(value):
    return value
