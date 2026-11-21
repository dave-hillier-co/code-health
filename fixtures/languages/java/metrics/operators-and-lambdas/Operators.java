// Operators, lambdas and the anonymous class, counted by hand. A lambda or anonymous class is one level deeper.
class Operators {
    boolean mixed(boolean a, boolean b, boolean c, boolean d) {
        return a && b || c && d;
    }

    boolean same(boolean a, boolean b, boolean c) {
        return a && b && c;
    }

    int nested(int[] items, boolean skip) {
        int total = 0;
        for (int item : items) {
            if (!skip && item > 0 || item < -10) {
                total += item;
            }
        }
        return total;
    }

    int withLambda(java.util.List<Integer> values) {
        int[] total = new int[1];
        values.forEach(v -> {
            if (v > 0) {
                total[0] += v;
            }
        });
        return total[0];
    }

    Runnable exprLambda(int n) {
        return () -> System.out.println(n);
    }

    Runnable anon(int n) {
        return new Runnable() {
            public void run() {
                if (n > 0) {
                    System.out.println(n);
                }
            }
        };
    }
}
