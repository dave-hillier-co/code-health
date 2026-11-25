use super::{AtomicEwma, Window};

pub struct Gauge {
    pub ewma: AtomicEwma,
    pub window: Window,
}
