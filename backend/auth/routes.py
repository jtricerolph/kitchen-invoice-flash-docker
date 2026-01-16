from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel, EmailStr

from database import get_db
from models.user import User, Kitchen
from .jwt import hash_password, verify_password, create_access_token, get_current_user

router = APIRouter()


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str
    name: str
    kitchen_name: str = "My Kitchen"  # Optional - ignored if kitchen exists


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UserResponse(BaseModel):
    id: int
    email: str
    name: str | None
    kitchen_id: int
    kitchen_name: str
    is_admin: bool

    class Config:
        from_attributes = True


@router.post("/register", response_model=TokenResponse)
async def register(request: RegisterRequest, db: AsyncSession = Depends(get_db)):
    """Register a new user - joins existing kitchen or creates first one"""
    # Check if email already exists
    result = await db.execute(select(User).where(User.email == request.email))
    if result.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email already registered"
        )

    # Check if a kitchen already exists (single kitchen per instance)
    kitchen_result = await db.execute(select(Kitchen).limit(1))
    kitchen = kitchen_result.scalar_one_or_none()

    is_first_user = kitchen is None

    if not kitchen:
        # First user - create the kitchen
        kitchen = Kitchen(name=request.kitchen_name)
        db.add(kitchen)
        await db.flush()  # Get kitchen ID

    # Create user - first user is admin
    user = User(
        email=request.email,
        password_hash=hash_password(request.password),
        name=request.name,
        kitchen_id=kitchen.id,
        is_admin=is_first_user
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    # Generate token
    access_token = create_access_token(data={"sub": str(user.id)})
    return TokenResponse(access_token=access_token)


@router.post("/login", response_model=TokenResponse)
async def login(request: LoginRequest, db: AsyncSession = Depends(get_db)):
    """Login with email and password"""
    result = await db.execute(select(User).where(User.email == request.email))
    user = result.scalar_one_or_none()

    if not user or not verify_password(request.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password"
        )

    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Account is disabled"
        )

    access_token = create_access_token(data={"sub": str(user.id)})
    return TokenResponse(access_token=access_token)


@router.get("/me", response_model=UserResponse)
async def get_me(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get current user info"""
    # Load kitchen relationship
    result = await db.execute(select(Kitchen).where(Kitchen.id == current_user.kitchen_id))
    kitchen = result.scalar_one()

    return UserResponse(
        id=current_user.id,
        email=current_user.email,
        name=current_user.name,
        kitchen_id=current_user.kitchen_id,
        kitchen_name=kitchen.name,
        is_admin=current_user.is_admin
    )


@router.post("/invite", response_model=TokenResponse)
async def invite_user(
    request: RegisterRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Invite a new user to the current kitchen (admin only)"""
    if not current_user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins can invite users"
        )

    # Check if email already exists
    result = await db.execute(select(User).where(User.email == request.email))
    if result.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email already registered"
        )

    # Create user in same kitchen
    user = User(
        email=request.email,
        password_hash=hash_password(request.password),
        name=request.name,
        kitchen_id=current_user.kitchen_id,
        is_admin=False
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    access_token = create_access_token(data={"sub": str(user.id)})
    return TokenResponse(access_token=access_token)


@router.post("/change-password")
async def change_password(
    request: ChangePasswordRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Change the current user's password"""
    # Verify current password
    if not verify_password(request.current_password, current_user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Current password is incorrect"
        )

    # Validate new password
    if len(request.new_password) < 6:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="New password must be at least 6 characters"
        )

    # Update password
    current_user.password_hash = hash_password(request.new_password)
    await db.commit()

    return {"message": "Password changed successfully"}


class UserListResponse(BaseModel):
    id: int
    email: str
    name: str | None
    is_active: bool
    is_admin: bool
    created_at: str

    class Config:
        from_attributes = True


@router.get("/users", response_model=list[UserListResponse])
async def list_users(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """List all users in the kitchen (admin only)"""
    if not current_user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins can view users"
        )

    result = await db.execute(
        select(User).where(User.kitchen_id == current_user.kitchen_id)
    )
    users = result.scalars().all()

    return [
        UserListResponse(
            id=u.id,
            email=u.email,
            name=u.name,
            is_active=u.is_active,
            is_admin=u.is_admin,
            created_at=u.created_at.isoformat()
        )
        for u in users
    ]


@router.patch("/users/{user_id}/toggle-active")
async def toggle_user_active(
    user_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Enable or disable a user (admin only)"""
    if not current_user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins can modify users"
        )

    if user_id == current_user.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot disable yourself"
        )

    result = await db.execute(
        select(User).where(
            User.id == user_id,
            User.kitchen_id == current_user.kitchen_id
        )
    )
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found"
        )

    user.is_active = not user.is_active
    await db.commit()

    return {"message": f"User {'enabled' if user.is_active else 'disabled'}", "is_active": user.is_active}


@router.delete("/users/{user_id}")
async def delete_user(
    user_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Delete a user (admin only)"""
    if not current_user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins can delete users"
        )

    if user_id == current_user.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot delete yourself"
        )

    result = await db.execute(
        select(User).where(
            User.id == user_id,
            User.kitchen_id == current_user.kitchen_id
        )
    )
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found"
        )

    if user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot delete admin users"
        )

    await db.delete(user)
    await db.commit()

    return {"message": "User deleted"}
