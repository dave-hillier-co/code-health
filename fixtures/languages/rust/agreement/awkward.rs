use std::fmt::Debug;

macro_rules! twice {
    ($e:expr) => {
        $e + $e
    };
}

pub struct Wrapper<T> {
    inner: T,
}

impl<T: Debug + Clone> Wrapper<T> {
    pub fn new(inner: T) -> Self {
        Wrapper { inner }
    }

    #[inline]
    pub fn describe(&self) -> String
    where
        T: Debug,
    {
        format!("{:?}", self.inner)
    }

    pub async fn load(&self, path: &str) -> Result<String, std::io::Error> {
        let text = read(path).await?;
        Ok(text)
    }

    pub const fn limit() -> usize {
        64
    }

    pub unsafe fn raw(&self) -> *const T {
        &self.inner as *const T
    }
}

pub trait Visitor {
    fn visit(&mut self, depth: usize) -> bool;

    fn visit_all(&mut self, items: &[usize]) -> usize {
        let mut seen = 0;
        for item in items {
            if self.visit(*item) {
                seen += 1;
            }
        }
        seen
    }
}

pub fn compose<A, B, C>(
    first: impl Fn(A) -> B,
    second: impl Fn(B) -> C,
) -> impl Fn(A) -> C {
    move |value| second(first(value))
}

pub fn apply_all(values: &[i32]) -> Vec<i32> {
    let double = |n: i32| -> i32 { n * 2 };
    let shift = |n: i32| n + 1;
    values.iter().map(|v| shift(double(*v))).collect()
}

pub fn longest<'a>(left: &'a str, right: &'a str) -> &'a str {
    if left.len() >= right.len() { left } else { right }
}

extern "C" fn callback(code: i32) -> i32 {
    code
}

pub mod nested {
    pub mod deeper {
        pub fn leaf() -> u8 {
            twice!(2)
        }
    }

    pub fn branch(flag: bool) -> u8 {
        match flag {
            true => deeper::leaf(),
            false => 0,
        }
    }
}
