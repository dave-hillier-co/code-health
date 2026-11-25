#[macro_export]
macro_rules! ensure {
    ($condition:expr) => {
        if !$condition {
            return false;
        }
    };
}

macro_rules! twice {
    ($value:expr) => {
        $value * 2
    };
}

pub(crate) use twice;
