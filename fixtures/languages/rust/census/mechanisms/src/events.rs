pub struct Bus;

impl EventEmitter for Bus {}

impl Bus {
    pub fn announce(&self) {
        self.emit(1);
    }

    fn emit(&self, n: i32) {
        let _ = n;
    }
}
