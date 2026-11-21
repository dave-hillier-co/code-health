mod rules;

use crate::config::{load, Settings};

pub fn run() -> bool {
    let settings: Settings = load();
    rules::check(&settings)
}
