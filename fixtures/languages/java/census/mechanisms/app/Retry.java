package app;

public class Retry {
    public static void retry(Runnable task) {
        task.run();
    }
}
