import logging

from logging_filters import RedactAccessLogQuery


def _access_record(target: str) -> logging.LogRecord:
    return logging.LogRecord(
        name="uvicorn.access",
        level=logging.INFO,
        pathname="",
        lineno=0,
        msg='%s - "%s %s HTTP/%s" %d',
        args=("127.0.0.1:1234", "GET", target, "1.1", 200),
        exc_info=None,
    )


def test_access_log_redacts_query_parameters():
    record = _access_record(
        "/api/auth/callback?code=temporary-code&state=private-state"
    )

    assert RedactAccessLogQuery().filter(record)
    assert record.getMessage() == '127.0.0.1:1234 - "GET /api/auth/callback HTTP/1.1" 200'
    assert "temporary-code" not in record.getMessage()
    assert "private-state" not in record.getMessage()


def test_access_log_without_query_is_unchanged():
    record = _access_record("/api/auth/status")

    assert RedactAccessLogQuery().filter(record)
    assert record.getMessage() == '127.0.0.1:1234 - "GET /api/auth/status HTTP/1.1" 200'
