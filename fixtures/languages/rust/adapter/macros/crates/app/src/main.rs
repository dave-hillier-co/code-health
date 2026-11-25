#[macro_use]
extern crate util;

mod other;

fn small(value: i32) -> bool {
    ensure!(value < 10);
    true
}

fn main() {
    let _ = small(3) && other::nonzero(3);
}
