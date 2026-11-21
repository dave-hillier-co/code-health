struct Walker;

impl Walker {
    fn visit(&self, node: &Node, Options { depth, strict }: Options) -> usize {
        if depth == 0 {
            return 0;
        }
        1 + self.visit(node, Options { depth: depth - 1, strict })
    }
}

trait Greeter {
    fn name(&self) -> String;
    fn greet(&self) -> String {
        format!("hello {}", self.name())
    }
}

fn outer(flag: bool) -> i32 {
    fn helper(x: i32) -> i32 {
        if x > 0 { x } else { 0 }
    }
    helper(1)
}
