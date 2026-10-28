#!/usr/bin/env python3
"""REHEARSAL - NEVER MERGE. Pastes lines, one at a time, into an INTERACTIVE shell on a pty (the way an operator pastes them into Terminal).
usage: drive-sheet.py <out> <shell> -- <line>...   The shell is started with a clean environment (whitelist below), the tty echo OFF
(so the output holds only what the commands print, not the typed text), no line editor, no rc files. After each line a sentinel command
is typed and awaited, so the next line is only pasted when the previous one has finished."""
import os, pty, sys, select, time, termios, signal
out, shell = sys.argv[1], sys.argv[2]
lines = sys.argv[sys.argv.index("--") + 1:]
KEEP = ("HOME", "PATH", "TERM", "FAKE_SCP_SRC", "FAKE_SCP_LOG", "FAKE_SCP_FAIL", "STUB_EXIT", "STUB_MARK", "TMPDIR")
env = {k: os.environ[k] for k in KEEP if k in os.environ}
if os.path.basename(shell) == "zsh":
    argv = [shell, "-f", "-i", "-o", "NO_ZLE"]
else:
    argv = [shell, "--noprofile", "--norc", "--noediting", "-i"]
pid, fd = pty.fork()
if pid == 0:
    os.execve(shell, argv, env)
attr = termios.tcgetattr(fd); attr[3] &= ~termios.ECHO; termios.tcsetattr(fd, termios.TCSANOW, attr)
buf = b""
def pump(until, limit):
    global buf
    t0 = time.time()
    while time.time() - t0 < limit:
        r, _, _ = select.select([fd], [], [], 0.3)
        if r:
            try:
                d = os.read(fd, 4096)
            except OSError:
                return False
            if not d: return False
            buf += d
            if until in buf: return True
    return until in buf
pump(b"\x00never", 1.5)
os.write(fd, b"PS1=''; PS2=''\n"); pump(b"\x00never", 0.7)
buf = b""
ok = True
for n, line in enumerate(lines):
    os.write(fd, (line + "\n").encode())
    os.write(fd, f"echo __DONE_{n}__\n".encode())
    if not pump(f"__DONE_{n}__\r".encode(), 60): ok = False; break
os.write(fd, b"exit\n")
pump(b"\x00never", 1.0)
try: os.kill(pid, signal.SIGKILL)
except ProcessLookupError: pass
try: os.waitpid(pid, 0)
except ChildProcessError: pass
open(out, "wb").write(buf)
sys.exit(0 if ok else 3)
