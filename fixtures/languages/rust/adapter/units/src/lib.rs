pub struct Point { pub x: i32, pub y: i32 }

pub enum Shape { Circle(Point, i32), Square(Point, i32) }

pub trait Area {
    fn area(&self) -> i32;
    fn describe(&self) -> String {
        format!("area {}", self.area())
    }
}

impl Point {
    pub fn new(x: i32, y: i32) -> Self {
        Point { x, y }
    }
}

impl Area for Shape {
    fn area(&self) -> i32 {
        match self {
            Shape::Circle(_, r) => 3 * r * r,
            Shape::Square(_, s) => s * s,
        }
    }
}

impl std::fmt::Display for Point {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "({}, {})", self.x, self.y)
    }
}

impl std::fmt::Debug for Point {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "Point")
    }
}

pub mod geometry {
    pub fn origin() -> super::Point {
        super::Point::new(0, 0)
    }
    pub struct Line;
    impl Line {
        pub fn length(&self) -> i32 {
            let double = |n: i32| n * 2;
            double(1)
        }
    }
}

fn outer() {
    fn inner() {}
    inner();
}

fn dup() {}
mod a { fn dup() {} }
