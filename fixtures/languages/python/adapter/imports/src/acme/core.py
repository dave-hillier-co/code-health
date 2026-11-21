import os
import requests
from collections import OrderedDict
from acme import util
import acme.models.user
import acme.models.user as account
from acme.missing import ghost


def go():
    util.clean()
    acme.models.user.save()
    account.save()
    return os.getcwd()
