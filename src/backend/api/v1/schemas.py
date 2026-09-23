from datetime import datetime
from typing import Annotated, Any, Dict, List, Literal, Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictStr


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PadSummary(StrictModel):
    id: str
    owner_id: str
    display_name: str
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    sharing_policy: str = "private"
    theme: Optional[str] = None
    is_scratch: bool = False
    pad_type: str = "canvas"
    tags: List[str] = Field(default_factory=list)
    folder: Optional[str] = None
    thumbnail_url: Optional[str] = None
    source_url: Optional[str] = None


class UserMeResponse(StrictModel):
    id: str
    username: str
    email: str
    email_verified: bool
    name: Optional[str] = None
    given_name: Optional[str] = None
    family_name: Optional[str] = None
    roles: List[str] = Field(default_factory=list)
    last_selected_pad: Optional[str] = None
    folders: List[str] = Field(default_factory=list)
    pads: List[PadSummary] = Field(default_factory=list)


class PadContentResponse(StrictModel):
    pad_id: str
    pad_type: str
    updated_at: Optional[str] = None
    data: Dict[str, Any] = Field(default_factory=dict)


class PadReadResponse(StrictModel):
    pad: PadSummary
    content: PadContentResponse


class SearchMatch(StrictModel):
    element_id: str = ""
    text: str
    excerpt: str


class SearchResult(StrictModel):
    pad_id: str
    pad_name: str
    name_match: bool
    matches: List[SearchMatch] = Field(default_factory=list)


class ApiErrorResponse(StrictModel):
    code: str
    message: str


class CreatePadRequest(StrictModel):
    display_name: StrictStr = Field(min_length=1, max_length=100)
    pad_type: Literal["canvas", "document", "kanban", "gantt", "latex", "database"] = "canvas"
    content: Optional[StrictStr] = Field(default=None, max_length=2_000_000)


class PadDataUpdateRequest(StrictModel):
    data: Dict[str, Any]


class PadMetadataUpdateRequest(StrictModel):
    display_name: Optional[StrictStr] = Field(default=None, min_length=1, max_length=100)
    theme: Optional[Literal["light", "dark"]] = None
    tags: Optional[List[Annotated[StrictStr, Field(max_length=50)]]] = Field(default=None, max_length=20)
    folder: Optional[StrictStr] = Field(default=None, max_length=80)


class PadMemberRequest(StrictModel):
    user_id: UUID
    role: Literal["editor", "viewer"]


class PadMemberResponse(StrictModel):
    id: UUID
    pad_id: UUID
    user_id: UUID
    role: str
    created_at: Optional[datetime] = None


class SharingPolicyRequest(StrictModel):
    policy: Literal["private", "whitelist", "public"]


class ApiTokenCreateRequest(StrictModel):
    name: StrictStr = Field(min_length=1, max_length=120)
    scopes: List[StrictStr] = Field(min_length=1, max_length=20)
    expires_in_days: int = Field(default=90, ge=1, le=365)


class ApiTokenResponse(StrictModel):
    id: UUID
    name: str
    token_prefix: str
    scopes: List[str]
    expires_at: datetime
    revoked_at: Optional[datetime] = None
    last_used_at: Optional[datetime] = None


class ApiTokenCreatedResponse(ApiTokenResponse):
    token: str
