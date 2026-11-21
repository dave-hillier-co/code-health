pub trait Store {
    fn save(&self);
}

pub struct Config {
    pub name: String,
}

pub enum Mode {
    Fast,
    Slow,
}
