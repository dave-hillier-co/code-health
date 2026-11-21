from . import b
from .b import helper
from .sub.deep import deepfn


def run():
    helper()
    b.other()
    return deepfn()
