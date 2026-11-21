package shapes

class Circle(val radius: Int) {
    companion object { val unit = Circle(1) }

    interface Visitor { fun visit(circle: Circle): Int }

    fun accept(visitor: Visitor): Int = visitor.visit(this)
}

class Square {
    companion object Factory { fun make(): Square = Square() }
    interface Listener { fun changed() }
}

class Tiny { val x = 1 }

fun after(): Int = 1
