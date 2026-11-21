pub struct Settings {
    pub verbose: bool,
}

pub fn load() -> Settings {
    Settings { verbose: false }
}
