from pyee import EventEmitter


class Bus(EventEmitter):
    pass


def announce(bus):
    bus.emit("announced")
