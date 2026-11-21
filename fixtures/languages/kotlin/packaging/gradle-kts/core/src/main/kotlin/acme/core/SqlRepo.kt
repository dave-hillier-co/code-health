package acme.core

class SqlRepo : Repo {
    override fun find(id: String): String = Hidden().wrap(id)
}
