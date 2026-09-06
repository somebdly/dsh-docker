#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""常驻 SSH 命令执行进程（Host 端 dsh-mcp-gateway-board 使用）。

通过 stdin/stdout 与 Node 宿主以「一行一个 JSON」协议通信，复用单个
paramiko SSH 连接执行远端命令（默认 docker mcp ...）。凭据从环境变量
读入（不入库、不落命令行）：

  MCPGW_SSH_HOST / MCPGW_SSH_PORT / MCPGW_SSH_USER / MCPGW_SSH_PWD
  MCPGW_SSH_AUTH         # "password"（默认）或 "key"
  MCPGW_SSH_KEY          # 私钥路径（auth=key 时使用）
  MCPGW_SSH_PASSPHRASE   # 私钥口令（可选）

请求： {"id": 1, "cmd": "docker mcp profile list --format json", "timeout": 30}
       {"id": 2, "cmd": "ping"}             # 连接健康检查
       {"id": 3, "cmd": "reconnect"}        # 强制重建 SSH 连接
       {"id": 4, "type": "pty-open", "cmd": "docker exec -it <ctr> sh", "timeout": 300}
                                             # 打开交互式 PTY 会话，返回 {"session": "..."}
       {"id": 5, "type": "pty-in", "session": "...", "data": "ls\r"}
                                             # 向会话写入输入字节
       {"id": 6, "type": "pty-resize", "session": "...", "cols": 120, "rows": 32}
                                             # 调整 PTY 终端尺寸
       {"id": 7, "type": "pty-close", "session": "..."}   # 结束会话
响应： {"id": 1, "ok": true, "stdout": "...", "stderr": "...", "exit": 0}
       {"id": 1, "ok": false, "error": "..."}
       {"id": 4, "ok": true, "session": "pt-xxx"}
       {"id": 4, "ok": false, "error": "..."}
PTY 输出事件（异步推送）：
       {"id": 0, "event": "pty-out", "session": "...", "data": "..."}
       {"id": 0, "event": "pty-exit", "session": "...", "exit": 0}
"""

import os
import sys
import json
import time
import uuid
import threading

try:
    import paramiko
except ImportError:  # pragma: no cover
    paramiko = None

# 全局输出锁：多线程（PTY 读线程）与主循环竞争 stdout
OUT_LOCK = threading.Lock()


def emit(obj):
    with OUT_LOCK:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()


def log(msg):
    sys.stderr.write("[ssh-exec] %s\n" % msg)
    sys.stderr.flush()


class SshExecutor:
    def __init__(self, host, port, user, pwd, auth="password", key=None, passphrase=None):
        self.host = host
        self.port = int(port or 22)
        self.user = user
        self.pwd = pwd
        self.auth = auth or "password"
        self.key = key
        self.passphrase = passphrase
        self.client = None
        self.lock = threading.Lock()

    def _connect_kwargs(self):
        if self.auth == "key" and self.key:
            kwargs = {"key_filename": self.key}
            if self.passphrase:
                kwargs["passphrase"] = self.passphrase
            return kwargs
        return {"password": self.pwd}

    def ensure(self):
        if self.client is not None:
            transport = self.client.get_transport()
            if transport is not None and transport.is_active():
                return self.client
            self.client = None
        cli = paramiko.SSHClient()
        cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        connect_args = {
            "hostname": self.host,
            "port": self.port,
            "username": self.user,
            "timeout": 20,
            "banner_timeout": 20,
            "auth_timeout": 20,
        }
        connect_args.update(self._connect_kwargs())
        try:
            cli.connect(**connect_args)
        except Exception:
            # key 认证失败时回退密码（若提供）
            if self.auth == "key" and self.pwd:
                cli = paramiko.SSHClient()
                cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
                connect_args.pop("key_filename", None)
                connect_args.pop("passphrase", None)
                connect_args["password"] = self.pwd
                cli.connect(**connect_args)
            else:
                raise
        self.client = cli
        return cli

    def reconnect(self):
        with self.lock:
            if self.client is not None:
                try:
                    self.client.close()
                except Exception:
                    pass
                self.client = None
        return True

    def run(self, cmd, timeout=60):
        if paramiko is None:
            return {"ok": False, "error": "paramiko 未安装"}
        with self.lock:
            try:
                cli = self.ensure()
            except Exception as e:
                return {"ok": False, "error": "SSH 连接失败: %s" % e}
            try:
                stdin, stdout, stderr = cli.exec_command(cmd, timeout=int(timeout or 60))
                out = stdout.read().decode("utf-8", errors="replace")
                err = stderr.read().decode("utf-8", errors="replace")
                code = stdout.channel.recv_exit_status()
                return {"ok": True, "stdout": out, "stderr": err, "exit": code}
            except Exception as e:
                self.client = None
                return {"ok": False, "error": "执行失败: %s" % e}

    # ---- 交互式 PTY 会话（docker exec -it ...）----

    def open_pty(self, cmd, on_output, on_exit, timeout=300):
        """打开一个交互式 PTY 会话，返回 session id（str）或抛出异常。
        on_output(session, data): 输出字节回调；on_exit(session, exit_code): 结束回调。
        """
        if paramiko is None:
            raise RuntimeError("paramiko 未安装")
        cli = self.ensure()
        chan = cli.get_transport().open_session()
        chan.get_pty(term="xterm-256color", width=120, height=32)
        chan.invoke_shell()
        chan.settimeout(timeout)

        session = "pt-" + uuid.uuid4().hex[:12]

        def reader():
            try:
                while True:
                    if chan.closed or chan.exit_status_ready():
                        break
                    try:
                        data = chan.recv(8192)
                    except Exception:
                        break
                    if not data:
                        break
                    on_output(session, data)
            finally:
                try:
                    exit_code = chan.recv_exit_status()
                except Exception:
                    exit_code = 0
                on_exit(session, exit_code)

        t = threading.Thread(target=reader, daemon=True)
        t.start()
        self._pty_channels[session] = {"chan": chan, "thread": t, "timeout": timeout}
        return session

    def write_pty(self, session, data):
        chan = self._get_chan(session)
        if chan is None:
            raise RuntimeError("会话不存在")
        if isinstance(data, str):
            data = data.encode("utf-8")
        chan.sendall(data)

    def resize_pty(self, session, cols, rows):
        chan = self._get_chan(session)
        if chan is None:
            raise RuntimeError("会话不存在")
        try:
            chan.resize_pty(width=int(cols) or 120, height=int(rows) or 32)
        except Exception:
            pass

    def close_pty(self, session):
        item = self._pty_channels.pop(session, None)
        if item is None:
            return False
        try:
            item["chan"].close()
        except Exception:
            pass
        return True

    def _get_chan(self, session):
        item = self._pty_channels.get(session)
        return item["chan"] if item else None

    # 会话注册表（实例级）
    _pty_channels = {}

    def close_all_pty(self):
        for session in list(self._pty_channels.keys()):
            self.close_pty(session)


def main():
    host = os.environ.get("MCPGW_SSH_HOST", "")
    port = os.environ.get("MCPGW_SSH_PORT", "22")
    user = os.environ.get("MCPGW_SSH_USER", "")
    pwd = os.environ.get("MCPGW_SSH_PWD", "")
    auth = os.environ.get("MCPGW_SSH_AUTH", "password")
    key = os.environ.get("MCPGW_SSH_KEY", "")
    passphrase = os.environ.get("MCPGW_SSH_PASSPHRASE", "")

    if paramiko is None:
        sys.stdout.write(json.dumps({"id": 0, "ok": False, "error": "paramiko 未安装"}) + "\n")
        sys.stdout.flush()
        return

    if not host or not user:
        sys.stdout.write(json.dumps({"id": 0, "ok": False, "error": "缺少 SSH 配置 (MCPGW_SSH_HOST/USER)"}) + "\n")
        sys.stdout.flush()
        return

    execr = SshExecutor(host, port, user, pwd, auth, key, passphrase)

    def on_output(session, data):
        try:
            emit({"id": 0, "event": "pty-out", "session": session, "data": data.decode("utf-8", errors="replace")})
        except Exception:
            pass

    def on_exit(session, exit_code):
        try:
            emit({"id": 0, "event": "pty-exit", "session": session, "exit": int(exit_code or 0)})
        except Exception:
            pass

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            emit({"id": None, "ok": False, "error": "bad json: %s" % e})
            continue

        rid = req.get("id")
        req_type = req.get("type", "")
        cmd = req.get("cmd", "")
        timeout = req.get("timeout", 60)

        if req_type == "pty-open":
            if not cmd:
                emit({"id": rid, "ok": False, "error": "pty-open 缺少 cmd"})
                continue
            try:
                session = execr.open_pty(cmd, on_output, on_exit, timeout)
                emit({"id": rid, "ok": True, "session": session})
            except Exception as e:
                emit({"id": rid, "ok": False, "error": "打开会话失败: %s" % e})
            continue

        if req_type == "pty-in":
            session = req.get("session", "")
            data = req.get("data", "")
            try:
                execr.write_pty(session, data)
                emit({"id": rid, "ok": True})
            except Exception as e:
                emit({"id": rid, "ok": False, "error": "写入失败: %s" % e})
            continue

        if req_type == "pty-resize":
            session = req.get("session", "")
            try:
                execr.resize_pty(session, req.get("cols", 120), req.get("rows", 32))
                emit({"id": rid, "ok": True})
            except Exception as e:
                emit({"id": rid, "ok": False, "error": "resize 失败: %s" % e})
            continue

        if req_type == "pty-close":
            session = req.get("session", "")
            try:
                execr.close_pty(session)
                emit({"id": rid, "ok": True})
            except Exception as e:
                emit({"id": rid, "ok": False, "error": "关闭失败: %s" % e})
            continue

        if cmd == "ping":
            res = execr.run("echo pong", timeout=10)
            res["id"] = rid
            res["pong"] = (res.get("stdout", "").strip() == "pong")
        elif cmd == "reconnect":
            execr.reconnect()
            res = {"id": rid, "ok": True, "stdout": "", "stderr": "", "exit": 0}
        elif cmd == "quit":
            res = {"id": rid, "ok": True, "stdout": "", "stderr": "", "exit": 0}
            emit(res)
            break
        else:
            res = execr.run(cmd, timeout)
            res["id"] = rid

        emit(res)


if __name__ == "__main__":
    main()
