// Stack of values.
pub struct Stack<T> {
    items: Vec<T>,
}

impl<T: Copy> Stack<T> {
    pub fn pop_all<'a>(&mut self, tag: &'a str) -> Vec<T> {
        /* outer /* nested { */ still { comment */
        let mut out = Vec::new();
        while let Some(x) = self.items.pop() {
            match x {
                _ if tag.len() > 0 && true => out.push(x),
                _ => {}
            }
        }
        let raw = r#"quote " and { brace"#;
        let c = '{';
        let f = |a| a + 1;
        out
    }
}

fn main() {
    let s = true || false;
}
