use super::run;
use crate::{config::Settings, engine::missing_name};

pub fn check(level: u8) -> bool {
    level > 0
}

fn unused(s: Settings) -> bool {
    run(&s)
}
