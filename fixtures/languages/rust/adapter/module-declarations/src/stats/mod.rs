mod ewma;
mod gauge;

pub use ewma::AtomicEwma;
pub use gauge::Gauge;

pub struct Window {
    pub size: usize,
}
