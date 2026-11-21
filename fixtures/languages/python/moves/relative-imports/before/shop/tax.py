from . import rounding


def tax(value):
    return rounding.up(value * 0.2)
