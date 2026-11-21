import os


class Account(Base):
    """An account."""

    rate = 2
    _secret = 1

    def __init__(self, owner, balance=0):
        self.owner = owner
        self._cache = None

    def deposit(self, amount):
        return amount

    def _audit(self):
        return 1

    def __repr__(self):
        return "account"

    @property
    def label(self):
        return self.owner


def make(owner, **options):
    """Build one."""
    return Account(owner, **options)


class Empty:
    pass
