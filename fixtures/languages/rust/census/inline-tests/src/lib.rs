pub trait CommandHandler {
    fn handle(&self);
}

pub struct Ping;

impl CommandHandler for Ping {
    fn handle(&self) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    struct MockHandler;

    impl CommandHandler for MockHandler {
        fn handle(&self) {}
    }
}
