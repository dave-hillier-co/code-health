class CreateUserHandler:
    def handle(self, command):
        return command


def wire(mediator):
    mediator.register_handler("create", CreateUserHandler())
    mediator.send("create")
