"""
用户管理工具 —— 创建/删除账号、改密码

用法:
    python manage_users.py add zhangsan          # 交互式输入密码
    python manage_users.py add zhangsan --pass 明文密码
    python manage_users.py list
    python manage_users.py remove zhangsan
    python manage_users.py passwd zhangsan        # 改密码

密码以 bcrypt 哈希保存在 users.json,不存明文。
"""
import sys
import json
import getpass
from pathlib import Path

import bcrypt

USERS_FILE = Path(__file__).parent / "users.json"


def load() -> dict:
    if USERS_FILE.exists():
        return json.loads(USERS_FILE.read_text(encoding="utf-8"))
    return {}


def save(users: dict):
    USERS_FILE.write_text(
        json.dumps(users, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def hash_pw(plain: str) -> str:
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt()).decode()


def get_password(args) -> str:
    if "--pass" in args:
        return args[args.index("--pass") + 1]
    p1 = getpass.getpass("设置密码: ")
    p2 = getpass.getpass("再次输入: ")
    if p1 != p2:
        sys.exit("两次输入不一致")
    if len(p1) < 8:
        sys.exit("密码至少 8 位")
    return p1


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    cmd = sys.argv[1]
    users = load()

    if cmd == "list":
        if not users:
            print("(无账号)")
        for name in users:
            print(name)

    elif cmd == "add":
        name = sys.argv[2]
        if name in users:
            sys.exit(f"用户 {name} 已存在,改密码用 passwd")
        users[name] = {"password_hash": hash_pw(get_password(sys.argv))}
        save(users)
        print(f"已创建用户:{name}")

    elif cmd == "passwd":
        name = sys.argv[2]
        if name not in users:
            sys.exit(f"用户 {name} 不存在")
        users[name]["password_hash"] = hash_pw(get_password(sys.argv))
        save(users)
        print(f"已更新密码:{name}")

    elif cmd == "remove":
        name = sys.argv[2]
        if users.pop(name, None) is None:
            sys.exit(f"用户 {name} 不存在")
        save(users)
        print(f"已删除用户:{name}")

    else:
        print(__doc__)


if __name__ == "__main__":
    main()
