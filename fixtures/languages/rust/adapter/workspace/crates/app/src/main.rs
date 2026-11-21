use core_lib::store::Store;
use core_lib::Clock;
use serde::Serialize;

struct System;

impl Clock for System {
    fn now(&self) -> u64 {
        0
    }
}

fn main() {
    let _store = Store::open();
}
