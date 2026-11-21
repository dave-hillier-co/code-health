from shop import Cart, checkout
from shop.pricing import tax


def run():
    checkout(Cart())
    return tax(3)
