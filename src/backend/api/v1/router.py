"""Versioned HTTP boundary for external and browser clients."""

from datetime import datetime
from typing import Any, Callable
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response, status
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from application.api_tokens import ApiTokenError, ApiTokenService
from application.errors import (
    ApplicationError,
    PermissionDeniedError,
    PreconditionRequiredError,
    ResourceNotFoundError,
    ValidationError,
)
from application.membership import MembershipService
from application.pad_writes import PadWriteService
from application.pads import PadQueryService, pad_summary
from application.principal import Principal, principal_from_session
from database.database import get_session
from dependencies import require_auth

from .schemas import (
    ApiTokenCreateRequest,
    ApiTokenCreatedResponse,
    ApiTokenResponse,
    CreatePadRequest,
    PadContentResponse,
    PadDataUpdateRequest,
    PadMemberRequest,
    PadMemberResponse,
    PadMetadataUpdateRequest,
    PadReadResponse,
    PadSummary,
    SearchResult,
    SharingPolicyRequest,
    UserMeResponse,
)


v1_router = APIRouter(prefix="/api/v1", tags=["v1"])


def get_pad_query_service(session: AsyncSession = Depends(get_session)) -> PadQueryService:
    return PadQueryService(session)


def get_pad_write_service(session: AsyncSession = Depends(get_session)) -> PadWriteService:
    return PadWriteService(session)


def get_membership_service(session: AsyncSession = Depends(get_session)) -> MembershipService:
    return MembershipService(session)


async def require_v1_auth(
    request: Request,
    session: AsyncSession = Depends(get_session),
) -> Principal:
    """Authenticate a browser session or an explicit v1 Bearer API token."""
    authorization = request.headers.get("Authorization", "")
    if authorization:
        scheme, _, credentials = authorization.partition(" ")
        if scheme.lower() != "bearer" or not credentials.strip():
            raise HTTPException(
                status_code=401,
                detail={"code": "unauthenticated", "message": "Invalid Authorization header"},
                headers={"WWW-Authenticate": "Bearer"},
            )
        principal = await ApiTokenService(session).authenticate(credentials.strip())
        if principal is None:
            raise HTTPException(
                status_code=401,
                detail={"code": "unauthenticated", "message": "Invalid or expired API token"},
                headers={"WWW-Authenticate": "Bearer"},
            )
        return principal

    try:
        user = await require_auth(request)
    except HTTPException as error:
        code = "forbidden" if error.status_code == 403 else "unauthenticated"
        raise HTTPException(
            status_code=error.status_code,
            detail={"code": code, "message": error.detail},
            headers=error.headers,
        ) from error
    return principal_from_session(user)


def require_v1_scope(scope: str) -> Callable[..., Any]:
    async def dependency(principal: Principal = Depends(require_v1_auth)) -> Principal:
        # Preserve compatibility with existing tests/internal overrides that
        # still return a UserSession-shaped object.
        has_scope = getattr(principal, "has_scope", lambda _: True)
        if not has_scope(scope):
            raise HTTPException(
                status_code=403,
                detail={
                    "code": "insufficient_scope",
                    "message": f"Scope '{scope}' is required",
                    "required_scope": scope,
                },
                headers={"WWW-Authenticate": f'Bearer scope="{scope}"'},
            )
        return principal
    return dependency


async def require_v1_browser_session(
    principal: Principal = Depends(require_v1_auth),
) -> Principal:
    if not getattr(principal, "is_session", False):
        raise HTTPException(
            status_code=403,
            detail={
                "code": "session_required",
                "message": "This operation requires an interactive browser session",
            },
        )
    return principal


def _http_error(error: ApplicationError) -> HTTPException:
    detail = {"code": error.code, "message": error.message}
    if error.details:
        detail["details"] = error.details
    return HTTPException(status_code=error.status_code, detail=detail)


def _etag(value: datetime | None) -> str:
    return f'"{value.isoformat()}"' if value else '"missing"'


def _if_match(value: str | None) -> datetime:
    if not value:
        raise _http_error(PreconditionRequiredError("If-Match is required for pad writes"))
    raw = value.strip()
    if raw == "*":
        raise _http_error(ValidationError("If-Match '*' is not accepted for pad writes"))
    if len(raw) >= 2 and raw[0] == '"' and raw[-1] == '"':
        raw = raw[1:-1]
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as error:
        raise _http_error(ValidationError("If-Match must contain a valid pad timestamp")) from error


def _member_response(member: Any) -> dict[str, Any]:
    return {
        "id": member.id,
        "pad_id": member.pad_id,
        "user_id": member.user_id,
        "role": member.role,
        "created_at": member.created_at,
    }


def _token_response(token: Any) -> dict[str, Any]:
    return {
        "id": token.id,
        "name": token.name,
        "token_prefix": token.token_prefix,
        "scopes": list(token.scopes or []),
        "expires_at": token.expires_at,
        "revoked_at": token.revoked_at,
        "last_used_at": token.last_used_at,
    }


@v1_router.get("/me", response_model=UserMeResponse)
async def get_me(
    user: Principal = Depends(require_v1_scope("me:read")),
    service: PadQueryService = Depends(get_pad_query_service),
):
    try:
        return await service.get_me(user.id, user)
    except ApplicationError as error:
        raise _http_error(error) from error


@v1_router.get("/pads", response_model=list[PadSummary])
async def list_pads(
    user: Principal = Depends(require_v1_scope("pads:read")),
    service: PadQueryService = Depends(get_pad_query_service),
):
    return await service.list_pads(user.id)


@v1_router.post("/pads", response_model=PadSummary, status_code=status.HTTP_201_CREATED)
async def create_pad(
    body: CreatePadRequest,
    response: Response,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    user: Principal = Depends(require_v1_scope("pads:write")),
    service: PadWriteService = Depends(get_pad_write_service),
):
    try:
        result, replayed = await service.create_pad(
            user,
            display_name=body.display_name,
            pad_type=body.pad_type,
            content=body.content,
            idempotency_key=idempotency_key,
        )
        response.status_code = status.HTTP_200_OK if replayed else status.HTTP_201_CREATED
        response.headers["ETag"] = _etag(datetime.fromisoformat(result["updated_at"].replace("Z", "+00:00")))
        return result
    except ApplicationError as error:
        raise _http_error(error) from error


@v1_router.get("/pads/{pad_id}", response_model=PadReadResponse)
async def read_pad(
    pad_id: UUID,
    response: Response,
    user: Principal = Depends(require_v1_scope("pads:read")),
    service: PadQueryService = Depends(get_pad_query_service),
):
    try:
        pad, data = await service.get_pad_content(pad_id, user.id)
        response.headers["ETag"] = _etag(pad.updated_at)
        return {
            "pad": pad_summary(pad),
            "content": {
                "pad_id": str(pad.id),
                "pad_type": pad.pad_type,
                "updated_at": data.get("updated_at"),
                "data": data,
            },
        }
    except ApplicationError as error:
        if isinstance(error, PermissionDeniedError):
            # A caller must not be able to distinguish a private pad from a
            # nonexistent one through the versioned read surface.
            raise _http_error(ResourceNotFoundError("Pad not found")) from error
        raise _http_error(error) from error


@v1_router.get("/pads/{pad_id}/content", response_model=PadContentResponse)
async def read_pad_content(
    pad_id: UUID,
    response: Response,
    user: Principal = Depends(require_v1_scope("pads:read")),
    service: PadQueryService = Depends(get_pad_query_service),
):
    try:
        pad, data = await service.get_pad_content(pad_id, user.id)
        response.headers["ETag"] = _etag(pad.updated_at)
        return {
            "pad_id": str(pad.id),
            "pad_type": pad.pad_type,
            "updated_at": data.get("updated_at"),
            "data": data,
        }
    except ApplicationError as error:
        if isinstance(error, PermissionDeniedError):
            raise _http_error(ResourceNotFoundError("Pad not found")) from error
        raise _http_error(error) from error


@v1_router.put("/pads/{pad_id}/content")
async def update_pad_content(
    pad_id: UUID,
    body: PadDataUpdateRequest,
    if_match: str | None = Header(default=None, alias="If-Match"),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    user: Principal = Depends(require_v1_scope("pads:write")),
    service: PadWriteService = Depends(get_pad_write_service),
):
    try:
        payload, _ = await service.update_data(
            user, pad_id, body.data, _if_match(if_match), idempotency_key
        )
        return JSONResponse(
            content=jsonable_encoder(payload),
            headers={"ETag": _etag(datetime.fromisoformat(payload["updated_at"].replace("Z", "+00:00")))},
        )
    except ApplicationError as error:
        raise _http_error(error) from error


@v1_router.patch("/pads/{pad_id}")
async def update_pad_metadata(
    pad_id: UUID,
    body: PadMetadataUpdateRequest,
    if_match: str | None = Header(default=None, alias="If-Match"),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    user: Principal = Depends(require_v1_scope("pads:write")),
    service: PadWriteService = Depends(get_pad_write_service),
):
    try:
        payload, _ = await service.update_metadata(
            user, pad_id, body.model_dump(exclude_unset=True), _if_match(if_match), idempotency_key
        )
        return JSONResponse(
            content=jsonable_encoder(payload),
            headers={"ETag": _etag(datetime.fromisoformat(payload["updated_at"].replace("Z", "+00:00")))},
        )
    except ApplicationError as error:
        raise _http_error(error) from error


@v1_router.get("/pads/{pad_id}/members", response_model=list[PadMemberResponse])
async def list_members(
    pad_id: UUID,
    user: Principal = Depends(require_v1_scope("pads:share")),
    service: MembershipService = Depends(get_membership_service),
):
    try:
        return [_member_response(member) for member in await service.list_members(user, pad_id)]
    except ApplicationError as error:
        raise _http_error(error) from error


@v1_router.put("/pads/{pad_id}/members/{user_id}", response_model=PadMemberResponse)
async def upsert_member(
    pad_id: UUID,
    user_id: UUID,
    body: PadMemberRequest,
    user: Principal = Depends(require_v1_scope("pads:share")),
    service: MembershipService = Depends(get_membership_service),
):
    if body.user_id != user_id:
        raise _http_error(ValidationError("Path user_id and body user_id must match"))
    try:
        return _member_response(await service.add_member(user, pad_id, user_id, body.role))
    except ApplicationError as error:
        raise _http_error(error) from error


@v1_router.delete("/pads/{pad_id}/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_member(
    pad_id: UUID,
    user_id: UUID,
    user: Principal = Depends(require_v1_scope("pads:share")),
    service: MembershipService = Depends(get_membership_service),
):
    try:
        await service.remove_member(user, pad_id, user_id)
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    except ApplicationError as error:
        raise _http_error(error) from error


@v1_router.put("/pads/{pad_id}/sharing", response_model=PadSummary)
async def update_sharing(
    pad_id: UUID,
    body: SharingPolicyRequest,
    user: Principal = Depends(require_v1_scope("pads:share")),
    service: MembershipService = Depends(get_membership_service),
):
    try:
        return pad_summary(await service.set_policy(user, pad_id, body.policy))
    except ApplicationError as error:
        raise _http_error(error) from error


@v1_router.get("/search", response_model=list[SearchResult])
async def search_pads(
    q: str = Query(min_length=0, max_length=200),
    limit: int = Query(default=50, ge=1, le=100),
    user: Principal = Depends(require_v1_scope("search:read")),
    service: PadQueryService = Depends(get_pad_query_service),
):
    return await service.search(user.id, q, limit=limit)


@v1_router.post("/tokens", response_model=ApiTokenCreatedResponse, status_code=status.HTTP_201_CREATED)
async def create_api_token(
    body: ApiTokenCreateRequest,
    user: Principal = Depends(require_v1_browser_session),
    session: AsyncSession = Depends(get_session),
):
    try:
        token, raw = await ApiTokenService(session).create(
            user, name=body.name, scopes=body.scopes, expires_in_days=body.expires_in_days
        )
        return {**_token_response(token), "token": raw}
    except ApiTokenError as error:
        raise HTTPException(
            status_code=422,
            detail={"code": "validation_error", "message": str(error)},
        ) from error


@v1_router.get("/tokens", response_model=list[ApiTokenResponse])
async def list_api_tokens(
    user: Principal = Depends(require_v1_browser_session),
    session: AsyncSession = Depends(get_session),
):
    return [_token_response(token) for token in await ApiTokenService(session).list_for_user(user.id)]


@v1_router.delete("/tokens/{token_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_api_token(
    token_id: UUID,
    user: Principal = Depends(require_v1_browser_session),
    session: AsyncSession = Depends(get_session),
):
    if not await ApiTokenService(session).revoke(user, token_id):
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Token not found"})
    return Response(status_code=status.HTTP_204_NO_CONTENT)
