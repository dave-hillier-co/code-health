use super::tax::rate;
use crate::pricing::round;

pub struct Money(pub i64);

impl Money {
    pub fn zero() -> Money {
        Money(round(rate()))
    }
}
