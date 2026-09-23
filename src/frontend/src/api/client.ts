export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: init.credentials ?? 'include',
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });

  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    const detail = payload?.detail;
    const message = typeof detail === 'string'
      ? detail
      : detail?.message || payload?.message || `Request failed (${response.status})`;
    throw new ApiError(message, response.status, detail?.code || payload?.code);
  }
  return payload as T;
}

export interface ApiPadSummary {
  id: string;
  owner_id: string;
  display_name: string;
  created_at: string | null;
  updated_at: string | null;
  sharing_policy: string;
  theme?: string | null;
  is_scratch: boolean;
  pad_type: string;
  tags: string[];
  folder?: string | null;
  thumbnail_url?: string | null;
  source_url?: string | null;
}

export interface ApiMe {
  id: string;
  username: string;
  email: string;
  email_verified: boolean;
  name?: string | null;
  given_name?: string | null;
  family_name?: string | null;
  roles: string[];
  last_selected_pad: string | null;
  folders: string[];
  pads: ApiPadSummary[];
}

export interface ApiPadContent {
  pad_id: string;
  pad_type: string;
  updated_at: string | null;
  data: Record<string, any>;
}

export interface ApiPadRead {
  pad: ApiPadSummary;
  content: ApiPadContent;
}

export interface ApiSearchResult {
  pad_id: string;
  pad_name: string;
  name_match: boolean;
  matches: Array<{ element_id: string; text: string; excerpt: string }>;
}

const v1 = '/api/v1';

export const apiV1 = {
  getMe: () => request<ApiMe>(`${v1}/me`),
  listPads: () => request<ApiPadSummary[]>(`${v1}/pads`),
  getPad: (padId: string) => request<ApiPadRead>(`${v1}/pads/${encodeURIComponent(padId)}`),
  getPadContent: (padId: string) => request<ApiPadContent>(`${v1}/pads/${encodeURIComponent(padId)}/content`),
  search: (query: string, limit = 50) => request<ApiSearchResult[]>(`${v1}/search?q=${encodeURIComponent(query)}&limit=${limit}`),
};
