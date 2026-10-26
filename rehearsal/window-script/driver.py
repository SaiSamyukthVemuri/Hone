#!/usr/bin/env python3
"""Drive an interactive script through a pty. usage: driver.py <out-file> <answers-file> -- <command...>
answers-file: lines "prompt substring<TAB>answer". Writes the terminal transcript to out-file; exits with the script's exit code."""
import os, pty, sys, select, time, signal, termios, re, datetime
out, answers_file = sys.argv[1], sys.argv[2]
cmd = sys.argv[sys.argv.index("--") + 1:]
answers = [l.rstrip("\n").split("\t", 1) for l in open(answers_file) if l.strip()]
def tok(s):
    # {now}, {now-90}, {now+60}: the UTC time at the moment the answer is typed, shifted by N seconds
    def r(m):
        off = int(m.group(1) or 0)
        return (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=off)).strftime("%Y-%m-%dT%H:%M:%SZ")
    return re.sub(r"\{now([+-][0-9]+)?\}", r, s)
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
buf = b""; pos = 0; i = 0; deadline = time.time() + 240; status = None
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
            if answers[i][0] in ("Supabase access token", "Database password"):
                # a hidden prompt: type only once the script has turned the terminal's echo off (a person types later than this)
                t0 = time.time()
                while time.time() - t0 < 5 and termios.tcgetattr(fd)[3] & termios.ECHO:
                    time.sleep(0.02)
            os.write(fd, (tok(answers[i][1]) + "\n").encode()); i += 1
else:
    os.kill(pid, signal.SIGKILL)
_, st = os.waitpid(pid, 0)
open(out, "wb").write(buf)
sys.exit(os.waitstatus_to_exitcode(st))
