package depth

import java.util.Locale

// The interface of a class is its constructor parameters and the members a user can reach.
class Shapes(private val names: List<String>, val limit: Int) {
    var a = 0
    private val hidden = 1

    fun first(): String {
        return names.first()
    }

    private fun secret() {
    }

    internal fun size(): Int = names.size

    fun save(key: String, value: Int) {
        store.save(key, value)
    }
}

interface Store {
    fun save(key: String, value: Int)

    fun load(key: String): Int
}
