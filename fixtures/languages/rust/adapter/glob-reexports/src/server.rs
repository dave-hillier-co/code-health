use crate::events::*;

pub fn fail(reason: String) -> Failed {
    Failed { reason }
}

pub fn report(event: &Failed) -> usize {
    describe(event).len()
}
