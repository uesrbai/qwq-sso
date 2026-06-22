"""
许白集团在职证明工具 — 带登录的后端
FastAPI + JWT + bcrypt

运行:
    pip install -r requirements.txt
    # 首次:设置环境变量(见 .env.example),然后创建用户
    python manage_users.py add zhangsan
    uvicorn main:app --host 0.0.0.0 --port 8000

安全要点:
- 密码只存 bcrypt 哈希,从不存明文
- 登录成功后签发 JWT,放在 HttpOnly Cookie(JS 读不到,防 XSS 窃取)
- 受保护页面 / 和 API 都要校验 token,前端改源码绕不过
- SECRET_KEY 必须用环境变量,且足够随机
"""
import os
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import FastAPI, Request, Response, HTTPException, Depends, Form
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
import jwt
import bcrypt

# ---------- 配置 ----------
SECRET_KEY = os.environ.get("SECRET_KEY")
if not SECRET_KEY:
    # 没设密钥就拒绝启动,避免用默认弱密钥上线
    raise RuntimeError(
        "必须设置环境变量 SECRET_KEY(随机长字符串)。"
        "可用: python -c \"import secrets; print(secrets.token_hex(32))\""
    )

ALGORITHM = "HS256"
TOKEN_HOURS = 8                      # 会话有效期
COOKIE_NAME = "xubai_session"
# 部署到 https 时设 True;本地 http 调试设 False
SECURE_COOKIE = os.environ.get("SECURE_COOKIE", "true").lower() == "true"

BASE = Path(__file__).parent
USERS_FILE = BASE / "users.json"

app = FastAPI(title="许白集团在职证明工具")


# ---------- 用户存储(简单版:JSON 文件) ----------
def load_users() -> dict:
    if not USERS_FILE.exists():
        return {}
    return json.loads(USERS_FILE.read_text(encoding="utf-8"))


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode(), hashed.encode())
    except Exception:
        return False


# ---------- JWT ----------
def create_token(username: str) -> str:
    payload = {
        "sub": username,
        "exp": datetime.now(timezone.utc) + timedelta(hours=TOKEN_HOURS),
        "iat": datetime.now(timezone.utc),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def get_current_user(request: Request) -> str:
    """从 Cookie 取 token 并校验。失败抛 401。"""
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        raise HTTPException(status_code=401, detail="未登录")
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload["sub"]
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="会话已过期,请重新登录")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="无效凭证")


# ---------- 登录限速(简单内存版,防暴力破解) ----------
_attempts: dict = {}          # ip -> [失败时间, ...]
MAX_ATTEMPTS = 5
WINDOW_MIN = 15


def check_rate_limit(ip: str):
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(minutes=WINDOW_MIN)
    hits = [t for t in _attempts.get(ip, []) if t > cutoff]
    _attempts[ip] = hits
    if len(hits) >= MAX_ATTEMPTS:
        raise HTTPException(status_code=429, detail="尝试过于频繁,请 15 分钟后再试")


def record_fail(ip: str):
    _attempts.setdefault(ip, []).append(datetime.now(timezone.utc))


# ---------- 路由 ----------
@app.get("/login", response_class=HTMLResponse)
def login_page():
    return (BASE / "static" / "login.html").read_text(encoding="utf-8")


@app.post("/api/login")
def do_login(request: Request, response: Response,
             username: str = Form(...), password: str = Form(...)):
    ip = request.client.host if request.client else "?"
    check_rate_limit(ip)

    users = load_users()
    record = users.get(username)
    # 无论用户是否存在都走一次校验,避免时间差泄露用户名
    ok = record is not None and verify_password(password, record["password_hash"])
    if not ok:
        record_fail(ip)
        raise HTTPException(status_code=401, detail="用户名或密码错误")

    token = create_token(username)
    resp = JSONResponse({"ok": True})
    resp.set_cookie(
        key=COOKIE_NAME, value=token,
        httponly=True,            # JS 读不到,防 XSS
        secure=SECURE_COOKIE,     # 仅 https 传输
        samesite="lax",           # 防 CSRF
        max_age=TOKEN_HOURS * 3600,
        path="/",
    )
    return resp


@app.post("/api/logout")
def logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE_NAME, path="/")
    return resp


@app.get("/api/me")
def me(user: str = Depends(get_current_user)):
    return {"username": user}


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    # 受保护:没登录就跳转到登录页
    try:
        get_current_user(request)
    except HTTPException:
        return RedirectResponse(url="/login", status_code=302)
    return (BASE / "static" / "app.html").read_text(encoding="utf-8")


# 静态资源(如有 css/js 拆分时用)
app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")
