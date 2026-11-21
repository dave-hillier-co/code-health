package acme

import java.util.Locale

class Shapes(private val names: List<String>) {
    val size: Int
        get() = names.size

    fun count(): Int {
        return names.size
    }

    fun count(limit: Int): Int = minOf(limit, names.size)

    override fun toString(): String {
        val r = { println("x") }
        return "Shapes"
    }

    interface Visitor {
        fun visit(shapes: Shapes)

        fun leave() {
        }
    }

    enum class Kind {
        ROUND,
        SQUARE;

        fun isRound(): Boolean {
            return this == ROUND
        }
    }

    data class Point(val x: Int, val y: Int) {
        fun sum(): Int = x + y
    }

    constructor() : this(emptyList()) {
        println("default")
    }

    fun make(): Runnable {
        return object : Runnable {
            override fun run() {
            }
        }
    }

    companion object Factory {
        fun of(name: String): Shapes = Shapes(listOf(name))
    }
}

object Registry {
    val all = mutableListOf<Shapes>()
}

fun top(a: Int): Int {
    fun local(b: Int) = b + 1
    return local(a)
}
