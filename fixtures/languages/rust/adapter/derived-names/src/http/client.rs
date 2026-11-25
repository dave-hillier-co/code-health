use crate::errors::build::UriParseSnafu;

pub fn reject(uri: &str) -> bool {
    UriParseSnafu { uri }.fail::<()>().is_err()
}
