package app

fun retry(task: () -> Unit) {
    task()
}
