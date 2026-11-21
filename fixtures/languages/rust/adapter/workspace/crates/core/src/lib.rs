pub mod store;

pub trait Clock {
    fn now(&self) -> u64;
}
