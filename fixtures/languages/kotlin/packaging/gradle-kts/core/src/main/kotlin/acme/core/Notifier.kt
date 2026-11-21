package acme.core

abstract class Notifier {
    abstract fun send(message: String)
}
