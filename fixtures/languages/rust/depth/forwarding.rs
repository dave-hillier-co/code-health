pub fn relay(a: i32) -> i32 {
    target(a)
}

pub fn fixed(id: &str) -> i32 {
    target(id, "x", 1)
}

pub fn borrowed(id: &mut i32) -> i32 {
    target(&mut id)
}

pub fn computed(id: i32) -> i32 {
    target(id + 1)
}

pub fn early(id: i32) -> i32 {
    if id < 0 {
        return 0;
    }
    target(id)
}

pub struct Shape {
    pub width: i32,
    height: i32,
    pub depth: i32,
}

pub trait Area {
    fn area(&self) -> i32;
    fn name(&self) -> i32 {
        forward(self)
    }
}
