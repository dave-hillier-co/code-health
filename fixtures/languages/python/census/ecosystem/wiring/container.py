from injector import Injector, inject, singleton

container = Injector()


@singleton
class Clock:
    pass


container.register(Clock)
container.bind(Clock, to=Clock)
