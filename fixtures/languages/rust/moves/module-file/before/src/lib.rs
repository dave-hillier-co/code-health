pub mod billing;
pub mod invoice;
pub mod pricing;

use billing::money::Money;

pub fn total() -> Money {
    Money::zero()
}
