// A unit forwards only when its whole body is one call whose arguments are its parameters or literals.
class Forwarding {
    fun relay(a: Int): Int {
        return target(a)
    }

    fun fixed(a: Int): Int = target(a, 1)

    fun bare(): Int = target()

    fun statement(s: String) {
        store.put(s)
    }

    fun computed(a: Int): Int = target(a + 1)

    fun creates(a: Int): Wrapper {
        return Wrapper(a)
    }

    fun early(a: Int): Int {
        if (a < 0) {
            return 0
        }
        return target(a)
    }
}
