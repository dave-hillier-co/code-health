def fact(n):
    if n <= 1:
        return 1
    return n * fact(n - 1)


class Counter:
    def tick(self, step):
        if step > 0:
            self.tick(step - 1)
        return step

    @staticmethod
    def build(a, b=2, *rest, key=None, **extra):
        return Counter.build(a)


def outer(items):
    def inner(item):
        if item:
            return 1
        return 0
    total = 0
    for item in items:
        total += inner(item)
    return total
