# REHEARSAL - NEVER MERGE. A protocol-aware TLS relay in front of the LOCAL Supavisor, standing in for the hosted
# pooler's TLS (the local Supavisor refuses SSL; the pinned CLI always attempts it). It is NOT Supavisor: it answers
# the Postgres SSLRequest with 'S', terminates TLS, and forwards the plain bytes. It adds no startup parameters.
import socket, ssl, struct, sys, threading
cert, key, lport, uport = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(cert, key)


def pipe(a, b):
    try:
        while True:
            d = a.recv(65536)
            if not d:
                break
            b.sendall(d)
    except Exception:
        pass
    for x in (a, b):
        try:
            x.shutdown(socket.SHUT_RDWR)
        except Exception:
            pass


def handle(c):
    try:
        first = c.recv(8, socket.MSG_WAITALL)
        up = socket.create_connection(("127.0.0.1", uport))
        if len(first) == 8 and struct.unpack("!II", first) == (8, 80877103):
            c.sendall(b"S")
            c = ctx.wrap_socket(c, server_side=True)
        else:
            up.sendall(first)
        threading.Thread(target=pipe, args=(c, up), daemon=True).start()
        pipe(up, c)
    except Exception:
        pass


srv = socket.socket()
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("0.0.0.0", lport))
srv.listen(64)
while True:
    conn, _ = srv.accept()
    threading.Thread(target=handle, args=(conn,), daemon=True).start()
