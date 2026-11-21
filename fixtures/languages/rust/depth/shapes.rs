use std::collections::HashMap;

pub enum Level {
    Low,
    High(u8),
}

pub struct Repo {
    store: Store,
    pub name: String,
}

impl Repo {
    /// Finds a record.
    pub fn find(&self, key: &str) -> Option<Record> {
        self.store.find(key)
    }

    pub fn size(&self) -> usize {
        self.store.len() + 1
    }
}

pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

pub fn audit(map: &HashMap<String, i32>) -> usize {
    // counts the entries
    map.len()
}
