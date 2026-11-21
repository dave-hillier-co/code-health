def plain(x):
    return x


@decorator
def decorated(x):
    return x


square = lambda n: n * n


class Widget(Base):
    """A widget."""

    size = 3

    def __init__(self, name):
        self.name = name

    def render(self):
        def helper():
            return 1

        return helper()

    @property
    def label(self):
        return self.name

    @label.setter
    def label(self, value):
        self.name = value

    @staticmethod
    def create():
        return Widget("w")

    class Inner:
        def deep(self):
            return 2


async def fetch(url):
    return url


def dup():
    return 1


def dup():
    return 2
