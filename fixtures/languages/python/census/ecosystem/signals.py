from blinker import signal

order_placed = signal("order-placed")


def place(order):
    order_placed.send(order)
    order_placed.connect(on_placed)
    logger.info("placed")
    sock.send(b"x")
