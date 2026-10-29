# REHEARSAL - NEVER MERGE. The TLS relay from rehearsal #1170 (scripts/ci/pooler-tlsfront.py) plus one counter: each accepted
# TCP connection appends a line to COUNT_FILE, so "how many connection attempts did the CLI make" is a measured number.
import os, socket, ssl, struct, sys, threading
cert, key, lport, uport = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
count = os.environ["COUNT_FILE"]
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(cert, key)
lock = threading.Lock()
def pipe(a, b):
    try:
        while True:
            d = a.recv(65536)
            if not d: break
            b.sendall(d)
    except Exception: pass
    for x in (a, b):
        try: x.shutdown(socket.SHUT_RDWR)
        except Exception: pass
def handle(c):
    try:
        with lock:
            open(count, "a").write("accept\n")
        first = c.recv(8, socket.MSG_WAITALL)
        up = socket.create_connection(("127.0.0.1", uport))
        if len(first) == 8 and struct.unpack("!II", first) == (8, 80877103):
            c.sendall(b"S"); c = ctx.wrap_socket(c, server_side=True)
        else:
            up.sendall(first)
        threading.Thread(target=pipe, args=(c, up), daemon=True).start()
        pipe(up, c)
    except Exception: pass
srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("0.0.0.0", lport)); srv.listen(64)
while True:
    conn, _ = srv.accept()
    threading.Thread(target=handle, args=(conn,), daemon=True).start()
