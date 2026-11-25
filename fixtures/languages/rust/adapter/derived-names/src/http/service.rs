use crate::errors::build::{BuildError, UriParseSnafu};

pub fn check(uri: &str) -> Result<(), BuildError> {
    if uri.is_empty() {
        return UriParseSnafu { uri }.fail();
    }
    Ok(())
}
