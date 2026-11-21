from app.retry import retry


def run():
    retry(lambda: None)
