use crate::ports::store::Store;

pub struct Memory;

impl Store for Memory {
    fn save(&self, key: &str) {
        let _ = key;
    }
}
