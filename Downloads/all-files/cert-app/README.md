# 许白集团在职证明工具(带登录)

在原来的纯前端填写工具外,加了一套**真实的服务器端登录**。登录校验全在后端,前端改源码绕不过去。

## 它做对了哪些安全点

- 密码用 **bcrypt** 哈希存储,绝不存明文
- 登录后签发 **JWT**,放在 **HttpOnly Cookie** —— 网页 JS 读不到,降低被 XSS 偷走的风险
- 首页 `/` 和接口都校验 token,未登录自动跳转登录页
- `SECRET_KEY` 强制走环境变量,不设就拒绝启动
- 登录失败**限速**(同 IP 15 分钟内 5 次),防暴力破解
- Cookie 带 `SameSite=Lax`,缓解 CSRF

## 本地运行

```bash
pip install -r requirements.txt

# 1. 生成并设置密钥
export SECRET_KEY=$(python -c "import secrets; print(secrets.token_hex(32))")
export SECURE_COOKIE=false          # 本地 http 调试用 false

# 2. 创建账号
python manage_users.py add zhangsan  # 按提示输入密码(≥8 位)

# 3. 启动
uvicorn main:app --host 0.0.0.0 --port 8000
```

打开 http://localhost:8000 → 自动跳到登录页 → 登录后进入填写工具。

## 账号管理

```bash
python manage_users.py list           # 列出账号
python manage_users.py add 用户名      # 新增
python manage_users.py passwd 用户名   # 改密码
python manage_users.py remove 用户名   # 删除
```

## 部署到云

部署后**务必**:

1. 用 https 域名,并设 `SECURE_COOKIE=true`
2. `SECRET_KEY` 设成随机长串,且不要提交进代码仓库
3. 在平台的环境变量面板里配置上面两个变量

### 阿里云 / 自有服务器
用 `uvicorn main:app` 配合 nginx 反代 + https 证书即可。建议用 systemd 或 supervisor 守护进程。

### Vercel
Vercel 更适合无状态函数,而本项目用了**本地文件存账号 + 内存限速**,在 Vercel 的无服务器环境下会丢失。两个办法:
- 简单:换成长驻服务器(阿里云 ECS / 轻量应用服务器),最省心
- 或:把 `users.json` 换成数据库(如 Postgres),限速换成 Redis,再上 Vercel

如果你确定要上 Vercel,告诉我,我帮你把存储层改成数据库版。

## 文件说明

| 文件 | 作用 |
|------|------|
| `main.py` | 后端:登录、JWT、受保护路由 |
| `manage_users.py` | 命令行管理账号 |
| `static/login.html` | 登录页 |
| `static/app.html` | 在职证明填写工具(原工具 + 退出按钮) |
| `users.json` | 账号库(运行 manage_users 后生成,**勿提交仓库**) |

## 一个诚实的提醒

这套方案能挡住"随便看看源码就想绕过"的人,达到了你说的"真能防住有心人"的常规标准。但任何系统的安全都还取决于:密钥是否保密、是否用了 https、服务器本身是否安全。如果这份证明涉及对外法律效力,建议再加审计日志和双因素验证 —— 需要的话我可以继续加。
