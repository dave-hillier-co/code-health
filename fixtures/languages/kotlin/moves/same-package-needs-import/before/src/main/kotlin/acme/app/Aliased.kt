package acme.app

import acme.util.Strings as Text

class Aliased {
    fun run(s: String): String {
        return Text.trim(s)
    }
}
