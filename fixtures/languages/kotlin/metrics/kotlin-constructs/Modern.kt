// when without a subject, try as an expression, a secondary constructor and recursion, counted by hand.
class Modern(val label: String) {
    fun classify(n: Int): String {
        return when {
            n < 0 -> "negative"
            n == 0 -> "zero"
            n < 10 -> {
                if (n % 2 == 0) "small even" else "small odd"
            }
            else -> "large"
        }
    }

    fun parse(text: String): Int {
        val value = try {
            text.toInt()
        } catch (e: NumberFormatException) {
            -1
        } finally {
            println("done")
        }
        return value
    }

    constructor(label: String, size: Int) : this(label) {
        if (size > 0) {
            println(size)
        }
    }

    fun viaThis(n: Int): Int = if (n == 0) 0 else this.viaThis(n - 1)

    fun notRecursive(other: Modern, n: Int): Int = if (n == 0) 0 else other.notRecursive(other, n - 1)

    fun each(vararg pairs: Pair<String, String>, action: (String) -> Unit) {
        pairs.forEach { (key, value) -> action(key + value) }
    }
}
