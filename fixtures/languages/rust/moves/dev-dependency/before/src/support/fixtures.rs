use bytes::Bytes;
use tempfile::tempdir;

pub fn scratch() -> Bytes {
    let _ = tempdir();
    Bytes::new()
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;
}
