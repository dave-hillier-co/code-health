use crate::jobs::queue::Queue;
use crate::jobs::retry::retry;
use crate::ports::store::Store;

pub struct Service {
    store: Box<dyn Store>,
}

impl Service {
    pub fn new(store: Box<dyn Store>) -> Self {
        Service { store }
    }

    pub fn run(&self) -> bool {
        retry(|| true)
    }

    pub fn queue(&self) -> bool {
        let mut queue = Queue::new(|| true);
        queue.replace(|| false);
        true
    }
}
