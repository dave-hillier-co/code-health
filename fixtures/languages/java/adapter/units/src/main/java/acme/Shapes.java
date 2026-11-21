package acme;

import java.util.List;

public class Shapes {
    private final List<String> names;

    public Shapes(List<String> names) {
        this.names = names;
    }

    public int count() {
        return names.size();
    }

    public int count(int limit) {
        return Math.min(limit, names.size());
    }

    @Override
    public String toString() {
        Runnable r = () -> System.out.println("x");
        return "Shapes";
    }

    interface Visitor {
        void visit(Shapes shapes);

        default void leave() {
        }
    }

    enum Kind {
        ROUND,
        SQUARE;

        boolean isRound() {
            return this == ROUND;
        }
    }

    record Point(int x, int y) {
        Point {
            if (x < 0) {
                throw new IllegalArgumentException();
            }
        }

        int sum() {
            return x + y;
        }
    }

    static Runnable make() {
        return new Runnable() {
            public void run() {
            }
        };
    }
}
