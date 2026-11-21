pub trait Store {
    fn save(&self, key: &str);
}
