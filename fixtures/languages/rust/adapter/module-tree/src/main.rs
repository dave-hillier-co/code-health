use demo::area_of;
use demo::Circle;

fn main() {
    let c = Circle::new(1.0);
    println!("{}", area_of(&c));
}
