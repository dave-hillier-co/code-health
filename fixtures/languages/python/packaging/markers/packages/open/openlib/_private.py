from typing import Protocol


class Secret(Protocol):
    def run(self): ...
