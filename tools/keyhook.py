#!/usr/bin/env python3
"""Spawn the signed WeChat copy under Frida and capture the 32-byte raw key.

Runs as a detached daemon so a QR login can span several agent turns.
Writes progress to <root>/keyhook.json and the key only to <root>/key.txt.
The key is never printed, never passed in argv, never put in the state file.
"""
import argparse
import json
import os
import re
import sys
import tempfile
import time

PHASES = ("spawning", "attached", "waiting", "captured")


def merge(path, patch):
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        data = {}
    data.update(patch)
    data["updated_at"] = time.time()
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix="keyhook.", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=1)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return data


def fail(state_path, code):
    merge(state_path, {"phase": "failed", "code": code})
    return 2


def write_key(root, key):
    path = os.path.join(root, "key.txt")
    fd, tmp = tempfile.mkstemp(prefix="key.", dir=root)
    try:
        with os.fdopen(fd, "w", encoding="ascii") as fh:
            fh.write(key + "\n")
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    os.chmod(path, 0o600)
    return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--app", required=True)
    ap.add_argument("--hook", required=True)
    ap.add_argument("--root", required=True)
    ap.add_argument("--timeout", type=int, default=300)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    state_path = os.path.join(args.root, "keyhook.json")
    merge(state_path, {"phase": "spawning", "pid": os.getpid(), "started_at": time.time()})

    if args.dry_run:
        for phase in PHASES[1:]:
            time.sleep(0.01)
            merge(state_path, {"phase": phase})
        return 0

    if not os.path.isfile(args.hook):
        return fail(state_path, "HOOK_MISSING")

    try:
        import frida
    except ImportError:
        return fail(state_path, "HOOK_MISSING")

    captured = {}

    def on_message(message, _data):
        blob = json.dumps(message, default=str)
        found = re.search(r"RAW_KEY=([a-f0-9]{64})", blob)
        if found and "key" not in captured:
            captured["key"] = found.group(1)

    try:
        device = frida.get_local_device()
        pid = device.spawn([args.app])
        session = device.attach(pid)
        with open(args.hook, encoding="utf-8") as fh:
            script = session.create_script(fh.read())
        script.on("message", on_message)
        script.load()
        device.resume(pid)
    except Exception:
        return fail(state_path, "SPAWN_FAILED")

    merge(state_path, {"phase": "waiting"})
    deadline = time.time() + args.timeout
    while time.time() < deadline and "key" not in captured:
        time.sleep(0.2)

    if "key" not in captured:
        return fail(state_path, "LOGIN_TIMEOUT")

    write_key(args.root, captured["key"])
    merge(state_path, {"phase": "captured", "key_len": len(captured["key"])})
    return 0


if __name__ == "__main__":
    sys.exit(main())
