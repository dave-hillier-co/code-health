package events;

import java.util.Observable;

public class Bus extends Observable {
    public void announce(String message) {
        bus.emit(message);
    }
}
