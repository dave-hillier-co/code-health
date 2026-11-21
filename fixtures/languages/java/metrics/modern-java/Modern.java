// Switch rules, try with resources, constructors and the shapes of recursion, counted by hand.
class Modern {
    String arrow(int day) {
        return switch (day) {
            case 1, 7 -> "weekend";
            case 2 -> "monday";
            default -> {
                if (day > 7) {
                    yield "invalid";
                }
                yield "weekday";
            }
        };
    }

    int resources(String path) throws Exception {
        try (java.io.Reader reader = new java.io.StringReader(path)) {
            int c = reader.read();
            while (c >= 0) {
                c = reader.read();
            }
            return c;
        } catch (java.io.IOException | RuntimeException e) {
            return -1;
        } finally {
            path = null;
        }
    }

    Modern(int a, int b) {
        this(a);
        if (b > 0) {
            System.out.println(b);
        }
    }

    Modern(int a) {
    }

    <T> int varargs(String label, T... items) {
        return items.length;
    }

    int viaThis(int n) {
        return n == 0 ? 0 : this.viaThis(n - 1);
    }

    static int viaOwner(int n) {
        return n == 0 ? 0 : Modern.viaOwner(n - 1);
    }

    int notRecursive(Modern other, int n) {
        return n == 0 ? 0 : other.notRecursive(other, n - 1);
    }
}
