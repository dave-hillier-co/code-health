def comprehensions(rows, limit):
    squares = [r * r for r in rows if r > limit]
    lookup = {r: 1 for r in rows}
    total = sum(r for r in rows)
    return squares, lookup, total


def lambdas(items):
    key = lambda item: item[0] if item else 0
    ordered = sorted(items, key=lambda item: item[1])
    return key, ordered


async def stream(source):
    async for chunk in source:
        if chunk:
            yield chunk
    else:
        yield None


def drain(queue):
    while queue:
        item = queue.pop()
        if item is None:
            continue
        if item < 0:
            break
    return len(queue)


def guards(command):
    match command:
        case [action, target] if target:
            return action
        case {"name": name}:
            return name
        case _ if command:
            return None
        case _:
            return ""
