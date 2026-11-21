fn classify(n: i32) -> &'static str {
    if n < 0 {
        "negative"
    } else if n == 0 {
        "zero"
    } else {
        "positive"
    }
}

fn tally(items: &[i32], limit: i32) -> i32 {
    let mut total = 0;
    for item in items {
        match item {
            0 => continue,
            n if *n > limit => break,
            n => total += n,
        }
    }
    while total > 100 {
        total -= 10;
    }
    total
}

fn lookup(map: &Map, key: &str, fallback: Option<i32>) -> Option<i32> {
    if let Some(v) = map.get(key) {
        return Some(v.parse::<i32>().ok()?);
    }
    if fallback.is_some() && key.len() > 2 || key.is_empty() {
        return fallback;
    }
    None
}

fn search(grid: &Grid, target: i32) -> bool {
    'rows: for row in grid.rows() {
        for cell in row {
            if cell == target {
                break 'rows;
            }
        }
    }
    let check = |x: i32| x > target;
    if grid.len() > 0 && let Some(first) = grid.first() {
        return check(*first) || search(grid, target + 1);
    }
    false
}
