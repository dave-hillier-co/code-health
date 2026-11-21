pub mod shapes;
mod util;
pub use shapes::circle::Circle;

pub fn area_of(c: &Circle) -> f64 {
    util::square(c.radius) * 3.14
}
