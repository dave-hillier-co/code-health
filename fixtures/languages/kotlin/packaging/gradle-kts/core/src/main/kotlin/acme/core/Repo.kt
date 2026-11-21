package acme.core

interface Repo {
    fun find(id: String): String
}
