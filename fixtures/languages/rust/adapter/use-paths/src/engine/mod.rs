mod rules;

use crate::config::Mode::Fast;
use crate::config::{self, Settings};
use self::rules::check;
use std::collections::HashMap;
use serde::Serialize;

pub fn run(settings: &Settings) -> bool {
    let _seen: HashMap<u8, u8> = HashMap::new();
    if matches!(settings.verbose, true) {
        return check(1) && config::default_ok();
    }
    let _ = Fast;
    false
}
