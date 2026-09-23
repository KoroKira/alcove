class ApplicationError(Exception):
    """Base error raised by an application use case."""

    code = "application_error"
    status_code = 400

    def __init__(self, message: str, details: dict | None = None):
        super().__init__(message)
        self.message = message
        self.details = details or {}


class ResourceNotFoundError(ApplicationError):
    code = "not_found"
    status_code = 404


class PermissionDeniedError(ApplicationError):
    code = "forbidden"
    status_code = 403


class ConflictError(ApplicationError):
    code = "conflict"
    status_code = 409


class PreconditionRequiredError(ApplicationError):
    code = "precondition_required"
    status_code = 428


class ValidationError(ApplicationError):
    code = "validation_error"
    status_code = 422
