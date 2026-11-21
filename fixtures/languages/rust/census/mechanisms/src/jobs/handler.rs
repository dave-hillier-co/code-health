pub trait CommandHandler {
    fn handle(&self);
}

pub struct Ping;

impl CommandHandler for Ping {
    fn handle(&self) {}
}
