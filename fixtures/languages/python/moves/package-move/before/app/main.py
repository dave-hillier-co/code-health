from app.billing import Invoice, total
from app import billing


def run():
    return total(Invoice()) + billing.total(None)
