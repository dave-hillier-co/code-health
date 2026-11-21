"""Module docs: if x: while y."""


class Parser:
    def parse(self, text):
        """Parse text.

            if broken:
        """
        out = []
        for line in text.split("\n"):
            if line and not line.startswith("#"):
                out.append(line)  # keep
            elif line:
                continue
        return out

    def noop(self): pass

def helper(x, y):
    return x or y
