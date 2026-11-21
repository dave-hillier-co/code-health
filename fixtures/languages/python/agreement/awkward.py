"""Module docstring that mentions def fake(): and class Fake."""
import functools


def one_liner(x): return x


def multi_line(
    first,
    second=None,
    *args,
):
    """Doc with def inside: def not_a_function(): pass"""
    return first


@functools.lru_cache(maxsize=None)
def cached(n):
    # a comment
    return n


class Outer:
    class Inner:
        def method(self):
            return 1

    def outer_method(self):
        text = """
def in_string():
    pass
"""
        return text

    async def run(self):
        async with lock:
            await self.outer_method()


def with_nested():
    def level_one():
        def level_two():
            return 2
        return level_two
    return level_one


def with_comprehension(rows):
    return [
        row
        for row in rows
        if row
    ]


handler = lambda value: value
