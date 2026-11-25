mod sync;

pub use sync::SyncTransform;

pub trait Transform {
    fn run(&self);
}
