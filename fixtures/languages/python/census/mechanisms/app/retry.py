from typing import Callable


def retry(task: Callable[[], None]) -> None:
    task()
