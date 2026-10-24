from typing import Optional, Dict, Any, Tuple
import json
import logging
import time
import hashlib
import jwt
from jwt.jwks_client import PyJWKClient
import httpx
from redis.asyncio import Redis as AsyncRedis

logger = logging.getLogger(__name__)


class Session:
    """Domain class for managing user sessions"""
    
    def __init__(self, redis_client: AsyncRedis, oidc_config: Dict[str, str]):
        """
        Initialize a new Session instance.
        
        Args:
            redis_client: The Redis client to use for session storage
            oidc_config: Configuration for the OIDC provider
        """
        self.redis_client = redis_client
        self.oidc_config = oidc_config
        self._jwks_client = None

    async def get(self, session_id: str) -> Optional[Dict[str, Any]]:
        """
        Get session data from Redis.
        
        Args:
            session_id: The session ID to retrieve
            
        Returns:
            The session data or None if not found
        """
        try:
            session_data = await self.redis_client.get(f"session:{session_id}")
            if session_data:
                return json.loads(session_data)
        except json.JSONDecodeError:
            logger.exception("Error decoding session data")
        except Exception:
            logger.exception("Error retrieving session")
        return None

    async def set(self, session_id: str, data: Dict[str, Any], expiry: int) -> bool:
        """
        Store session data in Redis with expiry in seconds.
        
        Args:
            session_id: The session ID to store
            data: The session data to store
            expiry: Time to live in seconds
            
        Returns:
            True if successful, False otherwise
        """
        try:
            await self.redis_client.setex(
                f"session:{session_id}", 
                expiry,
                json.dumps(data)
            )
            return True
        except Exception:
            logger.exception("Error storing session")
            return False

    async def delete(self, session_id: str) -> bool:
        """
        Delete session data from Redis.
        
        Args:
            session_id: The session ID to delete
            
        Returns:
            True if successful, False otherwise
        """
        try:
            await self.redis_client.delete(f"session:{session_id}")
            return True
        except Exception:
            logger.exception("Error deleting session")
            return False

    @staticmethod
    def _oauth_state_key(state: str) -> str:
        # Keep the bearer-like state value out of Redis key names and logs.
        digest = hashlib.sha256(state.encode("utf-8")).hexdigest()
        return f"oauth_state:{digest}"

    async def set_oauth_state(self, state: str, session_id: str, return_mode: str) -> bool:
        """Store one short-lived OIDC flow, independent of the browser session cookie.

        Browsers share cookies across tabs. A second login attempt can therefore
        replace session_id while the first tab is at the identity provider. The
        callback must resolve the session from its own one-time state instead.
        """
        try:
            await self.redis_client.setex(
                self._oauth_state_key(state),
                600,
                json.dumps({"session_id": session_id, "return_mode": return_mode}),
            )
            return True
        except Exception:
            logger.exception("Error storing OIDC state")
            return False

    async def consume_oauth_state(self, state: str) -> Optional[Dict[str, Any]]:
        """Atomically retrieve and delete a short-lived OIDC state record."""
        try:
            value = await self.redis_client.getdel(self._oauth_state_key(state))
            return json.loads(value) if value else None
        except json.JSONDecodeError:
            logger.exception("Error decoding OIDC state")
        except Exception:
            logger.exception("Error consuming OIDC state")
        return None

    def get_auth_url(self, state: str) -> str:
        """
        Generate the authentication URL for OIDC login.
        
        Returns:
            The authentication URL
        """
        auth_url = f"{self.oidc_config['server_url']}/realms/{self.oidc_config['realm']}/protocol/openid-connect/auth"
        from urllib.parse import urlencode
        params = {
            'client_id': self.oidc_config['client_id'],
            'response_type': 'code',
            'redirect_uri': self.oidc_config['redirect_uri'],
            'scope': 'openid profile email',
            'state': state,
        }
        return f"{auth_url}?{urlencode(params)}"

    def get_token_url(self) -> str:
        """
        Get the token endpoint URL.

        Returns:
            The token endpoint URL
        """
        base = self.oidc_config.get('internal_server_url') or self.oidc_config['server_url']
        return f"{base}/realms/{self.oidc_config['realm']}/protocol/openid-connect/token"

    def is_token_expired(self, token_data: Dict[str, Any], buffer_seconds: int = 30) -> bool:
        """
        Check if the access token is expired.

        Args:
            token_data: The token data to check
            buffer_seconds: Buffer time in seconds before actual expiration

        Returns:
            True if the token is expired, False otherwise
        """
        if token_data and token_data.get('dev_session'):
            return False

        if not token_data or 'access_token' not in token_data:
            return True
            
        try:
            # Get the signing key
            jwks_client = self._get_jwks_client()
            signing_key = jwks_client.get_signing_key_from_jwt(token_data['access_token'])
            
            # Decode with verification
            decoded = jwt.decode(
                token_data['access_token'],
                signing_key.key,
                algorithms=["RS256"],
                audience=self.oidc_config['client_id'],
                issuer=f"{self.oidc_config['server_url']}/realms/{self.oidc_config['realm']}",
            )
            
            # Check expiration
            exp_time = decoded.get('exp', 0)
            current_time = time.time()
            return current_time + buffer_seconds >= exp_time
        except jwt.ExpiredSignatureError:
            return True
        except Exception:
            logger.exception("Error checking token expiration")
            return True

    async def refresh_token(self, session_id: str, token_data: Dict[str, Any]) -> Tuple[bool, Dict[str, Any]]:
        """
        Refresh the access token using the refresh token.
        
        Args:
            session_id: The session ID
            token_data: The current token data containing the refresh token
            
        Returns:
            Tuple of (success, token_data)
        """
        if not token_data or 'refresh_token' not in token_data:
            return False, token_data
            
        try:
            async with httpx.AsyncClient() as client:
                refresh_response = await client.post(
                    self.get_token_url(),
                    data={
                        'grant_type': 'refresh_token',
                        'client_id': self.oidc_config['client_id'],
                        'client_secret': self.oidc_config['client_secret'],
                        'refresh_token': token_data['refresh_token']
                    }
                )
                
                if refresh_response.status_code != 200:
                    # response body may include refresh_token payload — log
                    # status only.
                    logger.warning("Token refresh failed (HTTP %s)", refresh_response.status_code)
                    return False, token_data
                    
                # Get new token data
                new_token_data = refresh_response.json()
                
                # Update session with new tokens
                expiry = new_token_data['refresh_expires_in']
                success = await self.set(session_id, new_token_data, expiry)
                if not success:
                    return False, token_data
                
                return True, new_token_data
        except Exception:
            logger.exception("Error refreshing token")
            return False, token_data

    def _get_jwks_client(self) -> PyJWKClient:
        """
        Get or create a PyJWKClient for token verification.

        Returns:
            The JWKs client
        """
        if self._jwks_client is None:
            base = self.oidc_config.get('internal_server_url') or self.oidc_config['server_url']
            jwks_url = f"{base}/realms/{self.oidc_config['realm']}/protocol/openid-connect/certs"
            self._jwks_client = PyJWKClient(jwks_url)
        return self._jwks_client

    async def track_event(self, session_id: str, event_type: str, metadata: Dict[str, Any] = None) -> bool:
        """
        Track a session event (login, logout, etc.).
        
        Args:
            session_id: The session ID
            event_type: The type of event
            metadata: Additional metadata for the event
            
        Returns:
            True if successful, False otherwise
        """
        try:
            session_data = await self.get(session_id)
            if session_data:
                if 'events' not in session_data:
                    session_data['events'] = []
                
                event = {
                    'type': event_type,
                    'timestamp': time.time(),
                    'metadata': metadata or {}
                }
                session_data['events'].append(event)
                
                # Update session with new event
                return await self.set(session_id, session_data, session_data.get('expires_in', 3600))
            return False
        except Exception:
            logger.exception("Error tracking event %s", event_type)
            return False
