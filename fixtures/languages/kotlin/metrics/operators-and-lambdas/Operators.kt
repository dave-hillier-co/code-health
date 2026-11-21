// Operators, lambdas and local functions, counted by hand. A lambda or local function is one level deeper.
class Operators {
    fun mixed(a: Boolean, b: Boolean, c: Boolean, d: Boolean): Boolean {
        return a && b || c && d
    }

    fun same(a: Boolean, b: Boolean, c: Boolean): Boolean = a && b && c

    // The elvis operator is a cyclomatic decision, as ?? is, and free in cognitive complexity. Safe calls are free in both.
    fun elvis(a: Int?, b: Int?): Int {
        val x = a ?: b ?: 0
        return x
    }

    fun safe(list: List<String>?): Int {
        return list?.firstOrNull()?.length ?: 0
    }

    fun nested(items: List<Int>, skip: Boolean): Int {
        var total = 0
        for (item in items) {
            if (!skip && item > 0 || item < -10) {
                total += item
            }
        }
        return total
    }

    fun withLambda(values: List<Int>): Int {
        var total = 0
        values.forEach { v ->
            if (v > 0) {
                total += v
            }
        }
        return total
    }

    fun local(n: Int): Int {
        fun double(x: Int) = x * 2
        return double(n)
    }

    fun exprLambda(n: Int): () -> Unit {
        return { println(n) }
    }

    fun anon(n: Int): Runnable {
        return object : Runnable {
            override fun run() {
                if (n > 0) {
                    println(n)
                }
            }
        }
    }
}
