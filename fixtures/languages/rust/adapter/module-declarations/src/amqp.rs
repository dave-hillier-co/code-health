use crate::tls::TlsConfig;

pub fn connect(config: &TlsConfig) -> bool {
    config.verify
}
