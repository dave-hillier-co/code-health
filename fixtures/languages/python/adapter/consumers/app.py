from typing import TYPE_CHECKING
from lib import f, g, deco, K

if TYPE_CHECKING:
    from lib import Shape


@deco
def run(shape: Shape):
    f()
    f()
    handler = g
    return K + 1
