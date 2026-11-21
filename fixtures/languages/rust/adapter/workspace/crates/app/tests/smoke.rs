use core_lib::store::Store;

#[test]
fn opens() {
    let _ = Store::open();
}
