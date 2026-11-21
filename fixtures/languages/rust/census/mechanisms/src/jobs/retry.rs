pub fn retry<F: Fn() -> bool>(task: F) -> bool {
    task()
}
