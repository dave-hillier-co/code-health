package awkward

import java.util.ArrayList
import java.util.Comparator

/** Shapes the lexical layer finds hard: expression bodies, extension functions, nested types, lambdas and objects. */
class Awkward<T : Comparable<T>>(private val capacity: Int = 10) {
    private val items = ArrayList<T>()

    init {
        items.ensureCapacity(capacity)
    }

    constructor() : this(10) {
        items.clear()
    }

    @Suppress("UNCHECKED_CAST")
    override fun toString(): String {
        return "Awkward" + items.size
    }

    fun <R> mapAll(
        mapper: (T) -> R,
        limit: Int = Int.MAX_VALUE,
    ): List<R> {
        val out = ArrayList<R>()
        for (item in items) {
            if (out.size >= limit) {
                break
            }
            out.add(mapper(item))
        }
        return out
    }

    fun max(): T? = items.maxOrNull()

    fun reversed(): Comparator<T> {
        return object : Comparator<T> {
            override fun compare(a: T, b: T): Int {
                return b.compareTo(a)
            }
        }
    }

    fun counterIncrementer(): () -> Unit {
        return {
            if (counter > 0) {
                counter++
            }
        }
    }

    class Node<V>(var value: V) {
        var next: Node<V>? = null

        fun hasNext(): Boolean {
            return next != null
        }

        fun size(): Int = if (next == null) 1 else 1 + next!!.size()
    }

    interface Shape {
        fun area(): Double

        fun describe(): String {
            return "shape " + area()
        }
    }

    enum class Level(val weight: Int) {
        LOW(1),
        HIGH(10);

        fun heavier(other: Level): Boolean = weight > other.weight
    }

    fun classify(n: Int): String {
        return when (n) {
            0 -> "zero"
            1, 2 -> "small"
            else -> "large"
        }
    }

    fun text(name: String): String {
        val quoted = "He said \"hi\" // not a comment"
        val brace = '}'
        /* a block comment with a } and a { in it */
        return "$quoted$brace${name.length}" + name // trailing comment
    }

    companion object Factory {
        var counter = 0

        fun create(): Awkward<Int> {
            return Awkward(5)
        }
    }
}

fun <T> List<T>.secondOrNull(): T? = if (size > 1) this[1] else null

fun sum(vararg values: Int): Int {
    var total = 0
    for (v in values) {
        total += v
    }
    return total
}

val doubled: (Int) -> Int = { it * 2 }
