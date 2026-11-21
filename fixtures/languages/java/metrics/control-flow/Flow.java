// Every unit here is counted by hand in expected.json. Comment lines and blank lines do not add to length.
class Flow {
    int plain(int a) {
        return a + 1;
    }

    String sign(int n) {
        // A comment inside the body is not a line of code.

        if (n < 0) {
            return "negative";
        } else if (n == 0) {
            return "zero";
        } else {
            return "positive";
        }
    }

    // Cognitive complexity specification, sumOfPrimes: for +1, nested for +2, if +3, labelled continue +1 = 7.
    int sumOfPrimes(int max) {
        int total = 0;
        OUT:
        for (int i = 1; i <= max; ++i) {
            for (int j = 2; j < i; ++j) {
                if (i % j == 0) {
                    continue OUT;
                }
            }
            total += i;
        }
        return total;
    }

    String describe(String kind, boolean flag) {
        switch (kind) {
            case "a":
            case "b":
                return flag ? "ab" : "other";
            case "c":
                return "c";
            default:
                return "none";
        }
    }

    int fact(int n) {
        try {
            return n <= 1 ? 1 : n * fact(n - 1);
        } catch (RuntimeException error) {
            do {
                n--;
            } while (n > 0 && error != null);
            throw error;
        }
    }
}
