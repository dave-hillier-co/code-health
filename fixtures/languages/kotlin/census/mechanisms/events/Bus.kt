package events

import java.util.Observable

class Bus : Observable() {
    fun announce(message: String) {
        bus.emit(message)
    }
}
