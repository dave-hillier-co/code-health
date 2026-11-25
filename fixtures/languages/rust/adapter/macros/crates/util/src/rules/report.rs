use crate::helpers::twice;

pub fn doubled(value: i32) -> i32 {
    twice!(value)
}

pub fn checked(value: i32) -> bool {
    crate::ensure!(value != 0);
    true
}
