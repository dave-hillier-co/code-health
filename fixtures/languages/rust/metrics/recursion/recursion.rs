fn fact(n: u64) -> u64 {
    if n <= 1 { 1 } else { n * fact(n - 1) }
}

struct Tree {
    left: Option<Box<Tree>>,
}

impl Tree {
    fn depth(&self) -> usize {
        match &self.left {
            Some(l) => 1 + l.depth(),
            None => 0,
        }
    }
    fn height(&self) -> usize {
        Self::measure(self)
    }
    fn measure(tree: &Tree) -> usize {
        if tree.is_leaf() { 0 } else { 1 + Tree::measure(&tree.left) }
    }
    fn count(&self) -> usize {
        1 + self.count()
    }
}
