pub struct Connected;

pub struct Failed {
    pub reason: String,
}

pub fn describe(event: &Failed) -> &str {
    &event.reason
}
