#!/usr/bin/env python3
"""REHEARSAL - NEVER MERGE. Drives an interactive script through a pty (how Sam's terminal behaves).
usage: driver.py <transcript-out> <answers-file> -- <command...>
answers-file: lines "prompt substring<TAB>answer". Hidden prompts (the password) are answered only after the script has
turned the terminal echo OFF (a person types later than that). {now-N}: UTC time N seconds ago, taken when typed.
Exit status = the script's. If the script exits before all answers were used, that is fine (a refusal)."""
import os, pty, sys, select, time, signal, termios, re, datetime
out, answers_file = sys.argv[1], sys.argv[2]
cmd = sys.argv[sys.argv.index("--") + 1:]
answers = [l.rstrip("\n").split("\t", 1) for l in open(answers_file) if l.strip()]
def tok(s):
    def r(m):
        off = int(m.group(1) or 0)
        return (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=off)).strftime("%Y-%m-%dT%H:%M:%SZ")
    return re.sub(r"\{now([+-][0-9]+)?\}", r, s)
pid, fd = pty.fork()
if pid == 0:
    env = {"HOME": os.environ["S1D_HOME"], "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "TERM": "xterm-256color"}
    if os.environ.get("S1D_EXTRA"):
        k, v = os.environ["S1D_EXTRA"].split("=", 1); env[k] = v
    os.execve(cmd[0], cmd, env)
buf = b""; pos = 0; i = 0; deadline = time.time() + 420; status = None
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 1.0)
    if r:
        try:
            d = os.read(fd, 4096)
        except OSError:
            break
        if not d:
            break
        buf += d
        while i < len(answers) and answers[i][0].encode() in buf[pos:]:
            pos = buf.index(answers[i][0].encode(), pos) + len(answers[i][0])
            if answers[i][0].startswith("Database password"):
                t0 = time.time()
                while time.time() - t0 < 5 and termios.tcgetattr(fd)[3] & termios.ECHO:
                    time.sleep(0.02)
                if termios.tcgetattr(fd)[3] & termios.ECHO:
                    open(out, "wb").write(buf + b"\n[driver] password prompt did not turn echo off\n"); os.kill(pid, signal.SIGKILL); sys.exit(97)
            if answers[i][1] == "^C":
                os.write(fd, b"\x03"); i += 1; continue
            os.write(fd, (tok(answers[i][1]) + "\n").encode()); i += 1
else:
    os.kill(pid, signal.SIGKILL)
    open(out, "wb").write(buf + b"\n[driver] timed out\n"); sys.exit(98)
_, st = os.waitpid(pid, 0)
open(out, "wb").write(buf)
sys.exit(os.waitstatus_to_exitcode(st))
