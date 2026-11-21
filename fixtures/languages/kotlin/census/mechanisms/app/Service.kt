package app

import ports.Store

@Service
class Service(private val store: Store)
