use tempfile::tempdir;

pub fn scratch() {
    let _ = tempdir();
}
