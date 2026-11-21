pub struct Settings {
    pub verbose: bool,
}

pub enum Mode {
    Fast,
    Slow,
}

pub fn default_ok() -> bool {
    true
}
