use super::Config;

pub struct Client(pub Config);

impl Client {
    pub fn new() -> Client {
        Client(Config)
    }
}
