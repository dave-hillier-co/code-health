pub struct Queue<F> {
    task: F,
}

impl<F: Fn() -> bool> Queue<F> {
    pub fn new(task: F) -> Self {
        Queue { task }
    }
}

impl<F> Queue<F>
where
    F: FnMut() -> bool,
{
    pub fn replace(&mut self, task: F) {
        self.task = task;
    }
}
