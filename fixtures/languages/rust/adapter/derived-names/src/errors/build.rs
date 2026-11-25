use snafu::Snafu;

#[derive(Debug, Snafu)]
pub enum BuildError {
    #[snafu(display("the uri {uri} does not parse"))]
    UriParse { uri: String },
}
