import sys
import json
from crabot_product_probe import VERSION

for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    method = request["method"]
    if method == "initialize":
        result = {"protocolVersion": request["params"]["protocolVersion"], "capabilities": {"tools": {}}, "serverInfo": {"name": "python-probe", "version": VERSION}}
    elif method == "tools/list":
        result = {"tools": [{"name": "runtime", "description": "Isolated Python dependency", "inputSchema": {"type": "object", "properties": {}}}]}
    elif method == "tools/call":
        result = {"content": [{"type": "text", "text": json.dumps({"version": VERSION, "python": sys.executable})}]}
    else:
        result = {}
    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
