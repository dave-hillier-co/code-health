from .tax import tax


def price(value):
    return value + tax(value)
