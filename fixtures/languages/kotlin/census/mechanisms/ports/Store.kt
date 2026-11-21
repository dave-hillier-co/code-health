package ports

interface Store {
    fun get(key: String): String
}
