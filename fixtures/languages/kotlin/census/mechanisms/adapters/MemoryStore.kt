package adapters

import ports.Store

class MemoryStore : Store {
    override fun get(key: String): String = key
}
