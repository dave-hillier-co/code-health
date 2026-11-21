package broken

func fine() int {
	return 1
}

func broken() int {
	return fine() +
}

func after() int {
	return 2
}
