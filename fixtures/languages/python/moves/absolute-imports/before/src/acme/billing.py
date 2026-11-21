import acme.tax
import acme.tax as levy
from acme.tax import compute
from acme import tax as tax_module


def bill(value):
    return acme.tax.compute(value) + levy.compute(value) + compute(value) + tax_module.compute(value)
