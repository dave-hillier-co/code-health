from typing import Protocol


class Open(Protocol):
    def run(self): ...


class _Closed(Protocol):
    def run(self): ...


class Concrete:
    pass
