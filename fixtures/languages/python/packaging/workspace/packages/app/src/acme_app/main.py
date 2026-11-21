import json
import numpy
from acme_core import Greeter
from acme_core._internal import secret


def run():
    Greeter().greet()
    return secret()
