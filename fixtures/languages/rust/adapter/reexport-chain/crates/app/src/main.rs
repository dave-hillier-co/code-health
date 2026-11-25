use pipeline_lib::config::Settings;
use pipeline_lib::transform::{SyncTransform, Transform};

struct Upper;

impl Transform for Upper {
    fn run(&self) {}
}

impl SyncTransform for Upper {
    fn step(&self) {}
}

fn main() {
    let settings = Settings { workers: 2 };
    let _copy = pipeline_lib::core::config::Settings { workers: settings.workers };
    Upper.run();
    Upper.step();
}
