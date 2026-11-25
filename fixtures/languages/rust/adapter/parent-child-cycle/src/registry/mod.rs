mod builder;

pub struct Registry {
    pub names: Vec<String>,
}

pub fn default_registry() -> Registry {
    builder::build()
}
