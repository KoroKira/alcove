import logging


class RedactAccessLogQuery(logging.Filter):
    """Keep request paths in Uvicorn access logs, but never query parameters.

    OAuth callbacks carry short-lived authorization codes and state values in
    their query string. Uvicorn's default access log includes the full URL, so
    redact the query before the record reaches its handlers.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        # Uvicorn's access log arguments are client, method, path+query,
        # HTTP version, and status. Leave unrelated log records untouched.
        if record.name == "uvicorn.access" and isinstance(args, tuple) and len(args) >= 4:
            request_target = args[2]
            if isinstance(request_target, str) and "?" in request_target:
                safe_args = list(args)
                safe_args[2] = request_target.split("?", 1)[0]
                record.args = tuple(safe_args)
        return True
