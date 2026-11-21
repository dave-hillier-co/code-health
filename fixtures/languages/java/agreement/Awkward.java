package awkward;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.function.Function;

/** Shapes the lexical layer finds hard: annotations, generics, nested types, lambdas and anonymous classes. */
public class Awkward<T extends Comparable<T>> {
    private final List<T> items = new ArrayList<>();
    private static int counter;

    static {
        counter = 1;
    }

    public Awkward() {
        this(10);
    }

    @SuppressWarnings("unchecked")
    public Awkward(int capacity) {
        for (int i = 0; i < capacity; i++) {
            items.add(null);
        }
    }

    @Override
    @Deprecated
    public String toString() {
        return "Awkward" + items.size();
    }

    public <R> List<R> mapAll(
            Function<? super T, ? extends R> mapper,
            int limit) throws IllegalStateException {
        List<R> out = new ArrayList<>();
        for (T item : items) {
            if (out.size() >= limit) {
                break;
            }
            out.add(mapper.apply(item));
        }
        return out;
    }

    public T max() {
        return items.stream().max(Comparator.naturalOrder()).orElse(null);
    }

    public Comparator<T> reversed() {
        return new Comparator<T>() {
            @Override
            public int compare(T a, T b) {
                return b.compareTo(a);
            }
        };
    }

    public Runnable counterIncrementer() {
        return () -> {
            if (counter > 0) {
                counter++;
            }
        };
    }

    public static int sum(int... values) {
        int total = 0;
        for (int v : values) {
            total += v;
        }
        return total;
    }

    static class Node<V> {
        V value;
        Node<V> next;

        Node(V value) {
            this.value = value;
        }

        boolean hasNext() {
            return next != null;
        }
    }

    interface Shape {
        double area();

        default String describe() {
            return "shape " + area();
        }

        static Shape unit() {
            return () -> 1.0;
        }
    }

    enum Level {
        LOW {
            @Override
            int weight() {
                return 1;
            }
        },
        HIGH {
            @Override
            int weight() {
                return 10;
            }
        };

        abstract int weight();

        static Level of(int score) {
            return score > 5 ? HIGH : LOW;
        }
    }

    record Pair<A, B>(A first, B second) {
        Pair {
            if (first == null) {
                throw new IllegalArgumentException("first");
            }
        }

        <C> Pair<A, C> withSecond(C other) {
            return new Pair<>(first, other);
        }
    }

    public String classify(int n) {
        switch (n) {
            case 0:
                return "zero";
            case 1:
            case 2:
                return "small";
            default:
                return "large";
        }
    }

    public String text(String name) {
        String quoted = "He said \"hi\" // not a comment";
        char brace = '}';
        /* a block comment with a } and a { in it */
        return quoted + brace + name; // trailing comment
    }
}
