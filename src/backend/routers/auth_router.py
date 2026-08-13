import secrets
import jwt
import httpx
import logging
from fastapi import APIRouter, Request, HTTPException, Depends
from fastapi.responses import RedirectResponse, FileResponse, JSONResponse
import os
from typing import Optional
import time

logger = logging.getLogger(__name__)

from config import (FRONTEND_URL, STATIC_DIR, PAD_DEV_MODE)
from dependencies import get_coder_api, get_session_domain
from coder import CoderAPI
from dependencies import optional_auth, UserSession
from domain.session import Session
from database.database import async_session
from domain.user import User
from domain.pad import Pad

DEV_USER_ID = "00000000-0000-0000-0000-000000000001"
DEV_USER_INFO = {
    "sub": DEV_USER_ID,
    "preferred_username": "local",
    "email": "local@localhost",
    "name": "Local User",
    "email_verified": True,
}

auth_router = APIRouter()

async def _ensure_scratch_pad(user_id_str: str) -> None:
    """Create the scratch pad for this user if one doesn't already exist."""
    from uuid import UUID
    from sqlalchemy import select as sa_select
    from database.models.pad_model import PadStore as _PadStore
    try:
        owner_id = UUID(user_id_str)
        async with async_session() as db_session:
            stmt = sa_select(_PadStore).where(_PadStore.owner_id == owner_id, _PadStore.is_scratch == True)
            result = await db_session.execute(stmt)
            if result.scalars().first() is None:
                pad = await Pad.create(db_session, owner_id=owner_id, display_name="Scratch")
                pad.is_scratch = True
                await pad.save(db_session)
    except Exception as e:
        logger.warning("Could not ensure scratch pad for %s: %s", user_id_str, e)

@auth_router.get("/login")
async def login(
    request: Request,
    session_domain: Session = Depends(get_session_domain),
    kc_idp_hint: str = None,
    popup: str = None
):
    if PAD_DEV_MODE:
        session_id = secrets.token_urlsafe(32)
        dev_session = {
            "dev_session": True,
            "sub": DEV_USER_ID,
            "username": DEV_USER_INFO["preferred_username"],
            "email": DEV_USER_INFO["email"],
            "name": DEV_USER_INFO["name"],
        }
        await session_domain.set(session_id, dev_session, 86400 * 30)
        async with async_session() as db_session:
            try:
                await User.ensure_exists(db_session, DEV_USER_INFO)
                await db_session.commit()
            except Exception as e:
                if "duplicate key" not in str(e) and "already exists" not in str(e):
                    raise
        await _ensure_scratch_pad(DEV_USER_ID)
        response = RedirectResponse('/')
        response.set_cookie('session_id', session_id, httponly=True, samesite='lax')
        return response

    session_id = secrets.token_urlsafe(32)

    auth_url = session_domain.get_auth_url()
    state = "popup" if popup == "1" else "default"

    if kc_idp_hint:
        auth_url = f"{auth_url}&kc_idp_hint={kc_idp_hint}"

    auth_url = f"{auth_url}&state={state}"

    response = RedirectResponse(auth_url)
    response.set_cookie('session_id', session_id, httponly=True, samesite='lax', secure=True)

    return response

@auth_router.get("/callback")
async def callback(
    request: Request, 
    code: str, 
    state: str = "default",
    coder_api: CoderAPI = Depends(get_coder_api),
    session_domain: Session = Depends(get_session_domain)
):
    session_id = request.cookies.get('session_id')
    if not session_id:
        raise HTTPException(status_code=400, detail="No session")
    
    # Exchange code for token
    async with httpx.AsyncClient() as client:
        token_response = await client.post(
            session_domain.get_token_url(),
            data={
                'grant_type': 'authorization_code',
                'client_id': session_domain.oidc_config['client_id'],
                'client_secret': session_domain.oidc_config['client_secret'],
                'code': code,
                'redirect_uri': session_domain.oidc_config['redirect_uri']
            }
        )
        
        if token_response.status_code != 200:
            raise HTTPException(status_code=400, detail="Auth failed")
        
        token_data = token_response.json()
        expiry = token_data['refresh_expires_in']
        
        # Store the token data in Redis
        success = await session_domain.set(session_id, token_data, expiry)
        if not success:
            raise HTTPException(status_code=500, detail="Failed to store session")
            
        # Track the login event
        await session_domain.track_event(session_id, 'login')
        
        access_token = token_data['access_token']
        user_info = jwt.decode(access_token, options={"verify_signature": False})
        
        # Ensure user exists in database (only during login)
        async with async_session() as db_session:
            try:
                await User.ensure_exists(db_session, user_info)
            except Exception as e:
                # Handle duplicate key violations gracefully - this means user already exists
                if "duplicate key value violates unique constraint" in str(e) or "already exists" in str(e):
                    logger.debug("User %s already exists (race condition handled)", user_info.get('sub'))
                else:
                    raise e
        
        try:
            user_data, _ = coder_api.ensure_user_exists(
                user_info
            )
            coder_api.ensure_workspace_exists(user_data['username'])
        except Exception:
            logger.exception("Error in user/workspace setup")
            # Continue with login even if Coder API fails

    if state == "popup":
        return FileResponse(os.path.join(STATIC_DIR, "auth/popup-close.html"))
    else:
        return RedirectResponse('/')
    
@auth_router.get("/logout")
async def logout(request: Request, session_domain: Session = Depends(get_session_domain)):
    session_id = request.cookies.get('session_id')
    
    if not session_id:
        return RedirectResponse('/')
    
    session_data = await session_domain.get(session_id)
    if not session_data:
        return RedirectResponse('/')
    
    id_token = session_data.get('id_token', '')
    
    # Track logout event before deleting session
    await session_domain.track_event(session_id, 'logout')
    
    # Delete the session from Redis
    success = await session_domain.delete(session_id)
    if not success:
        logger.warning("Failed to delete session")
    
    # Create the Keycloak logout URL with redirect back to our app
    logout_url = f"{session_domain.oidc_config['server_url']}/realms/{session_domain.oidc_config['realm']}/protocol/openid-connect/logout"
    full_logout_url = f"{logout_url}?id_token_hint={id_token}&post_logout_redirect_uri={FRONTEND_URL}"
    
    # Create a response with the logout URL and clear the session cookie
    response = JSONResponse({"status": "success", "logout_url": full_logout_url})
    response.delete_cookie(
        key="session_id",
        path="/",
        secure=True,
        httponly=True,
        samesite="lax"
    )
    
    return response

@auth_router.get("/status")
async def auth_status(
    user_session: Optional[UserSession] = Depends(optional_auth)
):
    """Check if the user is authenticated and return session information"""
    if not user_session:
        return JSONResponse({
            "authenticated": False,
            "message": "Not authenticated"
        })
    
    try:
        expires_in = user_session.token_data.get('exp') - time.time()
                
        return JSONResponse({
            "authenticated": True,
            "user": {
                "id": str(user_session.id),
                "username": user_session.username,
                "email": user_session.email,
                "name": user_session.name
            },
            "expires_in": expires_in
        })
    except Exception as e:
        return JSONResponse({
            "authenticated": False,
            "message": f"Error processing session: {str(e)}"
        })

@auth_router.post("/refresh")
async def refresh_session(request: Request, session_domain: Session = Depends(get_session_domain)):
    """Refresh the current session's access token"""
    session_id = request.cookies.get('session_id')
    if not session_id:
        raise HTTPException(status_code=401, detail="No session found")
    
    session_data = await session_domain.get(session_id)
    if not session_data:
        raise HTTPException(status_code=401, detail="Invalid session")
    
    # Try to refresh the token
    success, new_token_data = await session_domain.refresh_token(session_id, session_data)
    if not success:
        raise HTTPException(status_code=401, detail="Failed to refresh session")
    
    # Return the new expiry time
    return JSONResponse({
        "expires_in": new_token_data.get('expires_in'),
        "authenticated": True
    })