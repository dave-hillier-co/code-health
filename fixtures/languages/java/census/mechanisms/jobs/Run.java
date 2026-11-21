package jobs;

import app.Retry;

public class Run {
    public void run() {
        Retry.retry(() -> {});
    }
}
