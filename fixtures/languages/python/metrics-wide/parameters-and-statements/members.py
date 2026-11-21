def parameters(a, /, b, *, c, d=1, **options):
    return a


class Service:
    def method(self, *args, **kwargs):
        return args

    @classmethod
    def make(cls, config):
        return cls()

    def plain(this, value):
        return value

    @staticmethod
    def helper(self):
        return self


def statements(path):
    import os
    global counter
    with open(path) as handle:
        data = handle.read()
    assert data, "empty"
    del data
    pass
    if (size := len(path)) > 3:
        raise ValueError(size)
    return path
