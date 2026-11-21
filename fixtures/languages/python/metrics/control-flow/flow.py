def plain(x):
    return x


def sign(n):
    if n < 0:
        return -1
    elif n == 0:
        return 0
    else:
        return 1


def sum_of_primes(limit):
    total = 0
    for candidate in range(2, limit):
        prime = True
        for divisor in range(2, candidate):
            if candidate % divisor == 0:
                prime = False
                break
        if prime:
            total += candidate
    return total


def describe(kind, value):
    match kind:
        case "a":
            return 1
        case "b" | "c":
            return 2
        case _:
            return 3


def risky(path):
    try:
        handle = open(path)
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as error:
        raise RuntimeError(error)
    finally:
        cleanup()


def operators(a, b, c, d):
    if a and b or c:
        return 1
    flag = a and b and c
    value = b if a else (c or d)
    return not (a and d)
