# Tiny refusing proxy: logs the first request line of every connection, answers 502, closes. Used only to SEE outbound
# connection attempts of a CLI run with HTTPS_PROXY/HTTP_PROXY pointing here. No traffic is forwarded.
import socketserver, sys
log = open(sys.argv[2], "a", buffering=1)
class H(socketserver.StreamRequestHandler):
    def handle(self):
        try:
            line = self.rfile.readline(2000).decode("latin1").strip()
            log.write(line + "\n")
            self.wfile.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
        except Exception as e:
            log.write("ERR %s\n" % e)
socketserver.ThreadingTCPServer.allow_reuse_address = True
socketserver.ThreadingTCPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
