pub mod io;
pub mod net;

use net::client::Client;

pub fn connect() -> Client {
    Client::new()
}
