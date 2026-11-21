use std::collections::HashMap;

pub struct Registry {
    handlers: HashMap<String, fn()>,
}
