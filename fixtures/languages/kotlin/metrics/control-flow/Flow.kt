// Every unit here is counted by hand in expected.json. Comment lines and blank lines do not add to length.
class Flow {
    fun plain(a: Int): Int {
        return a + 1
    }

    fun sign(n: Int): String {
        // A comment inside the body is not a line of code.

        if (n < 0) {
            return "negative"
        } else if (n == 0) {
            return "zero"
        } else {
            return "positive"
        }
    }

    // Cognitive complexity specification, sumOfPrimes: for +1, nested for +2, if +3, labelled continue +1 = 7.
    fun sumOfPrimes(max: Int): Int {
        var total = 0
        outer@ for (i in 1..max) {
            for (j in 2 until i) {
                if (i % j == 0) {
                    continue@outer
                }
            }
            total += i
        }
        return total
    }

    fun describe(kind: String, flag: Boolean): String {
        when (kind) {
            "a", "b" -> return if (flag) "ab" else "other"
            "c" -> return "c"
            else -> return "none"
        }
    }

    fun fact(n: Int): Int {
        var m = n
        try {
            return if (m <= 1) 1 else m * fact(m - 1)
        } catch (error: RuntimeException) {
            do {
                m--
            } while (m > 0 && m != 5)
            throw error
        }
    }
}
