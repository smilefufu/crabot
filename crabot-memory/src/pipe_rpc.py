"""Private bidirectional Memory transport. stdout is reserved for framed MessagePack."""
import asyncio
import os
import struct
import threading
import uuid

import msgpack


class PipeRpcError(RuntimeError):
    def __init__(self, code, message, details=None):
        super().__init__(message)
        self.code = code
        self.details = details


class PipeRpcPeer:
    def __init__(self, source, read_fd=0, write_fd=1):
        self.source = source
        self.read_fd = read_fd
        self.write_fd = write_fd
        self.loop = asyncio.get_running_loop()
        self.pending = {}
        self.tasks = set()
        self.buffer = bytearray()
        self.closed = asyncio.Event()
        self.write_lock = asyncio.Lock()
        self.handler = None

    async def serve(self, handler):
        self.handler = handler
        # os.read avoids holding Python's buffered stdin lock during interpreter exit.
        threading.Thread(target=self._read, daemon=True).start()
        await self.closed.wait()
        if self.tasks:
            await asyncio.gather(*self.tasks, return_exceptions=True)

    def _read(self):
        try:
            while chunk := os.read(self.read_fd, 65536):
                self.loop.call_soon_threadsafe(self._receive, chunk)
        except (OSError, RuntimeError):
            pass
        finally:
            try:
                self.loop.call_soon_threadsafe(self.close)
            except RuntimeError:
                pass

    def close(self):
        if self.closed.is_set():
            return
        self.closed.set()
        for future in self.pending.values():
            if not future.done():
                future.set_exception(PipeRpcError("SERVICE_UNAVAILABLE", "Runtime channel disconnected"))
        self.pending.clear()

    async def call(self, target, method, params, authorization_bearer=None, timeout=10):
        if self.closed.is_set():
            raise PipeRpcError("SERVICE_UNAVAILABLE", "Runtime channel disconnected")
        request_id = str(uuid.uuid4())
        future = self.loop.create_future()
        self.pending[request_id] = future
        call = {"target": target, "source": self.source, "method": method, "params": params}
        if authorization_bearer is not None:
            call["metadata"] = {"authorizationBearer": authorization_bearer}
        try:
            await self._send({"type": "crabot:rpc", "kind": "call", "id": request_id, "call": call})
            return await asyncio.wait_for(future, timeout)
        finally:
            self.pending.pop(request_id, None)
            if not future.done():
                future.cancel()
            elif not future.cancelled():
                future.exception()

    async def _send(self, value):
        if self.closed.is_set():
            raise PipeRpcError("SERVICE_UNAVAILABLE", "Runtime channel disconnected")
        data = msgpack.packb(value, use_bin_type=True)
        packet = struct.pack(">I", len(data)) + data
        def write():
            offset = 0
            while offset < len(packet):
                size = os.write(self.write_fd, packet[offset:])
                if size == 0:
                    raise BrokenPipeError()
                offset += size
        async with self.write_lock:
            try:
                await asyncio.to_thread(write)
            except OSError:
                self.close()
                raise PipeRpcError("SERVICE_UNAVAILABLE", "Runtime send failed") from None

    def _receive(self, chunk):
        if self.closed.is_set():
            return
        self.buffer.extend(chunk)
        try:
            while len(self.buffer) >= 4:
                size = struct.unpack(">I", self.buffer[:4])[0]
                if len(self.buffer) < size + 4:
                    break
                message = msgpack.unpackb(self.buffer[4:size + 4], raw=False)
                del self.buffer[:size + 4]
                if not isinstance(message, dict) or message.get("type") != "crabot:rpc":
                    continue
                request_id = message.get("id")
                if not isinstance(request_id, str) or len(request_id) > 128:
                    continue
                if message.get("kind") == "call":
                    task = asyncio.create_task(self._dispatch(message))
                    self.tasks.add(task)
                    task.add_done_callback(self.tasks.discard)
                else:
                    future = self.pending.get(request_id)
                    if future is None or future.done():
                        continue
                    if message.get("kind") == "result":
                        future.set_result(message.get("value"))
                    elif message.get("kind") == "error":
                        error = message.get("error", {})
                        future.set_exception(PipeRpcError(error.get("code", "INTERNAL_ERROR"), error.get("message", "Runtime call failed"), error.get("details")))
        except Exception:
            self.close()

    async def _dispatch(self, message):
        try:
            call = message.get("call", {})
            if not isinstance(call, dict) or not isinstance(call.get("method"), str) or not self.handler:
                raise PipeRpcError("INVALID_PARAMS", "Invalid runtime call")
            bearer = call.get("metadata", {}).get("authorizationBearer")
            if bearer is not None and (not isinstance(bearer, str) or not bearer or "\r" in bearer or "\n" in bearer):
                raise PipeRpcError("UNAUTHORIZED", "Invalid Authorization metadata")
            value = await self.handler(call)
            reply = {"type": "crabot:rpc", "kind": "result", "id": message["id"], "value": value}
        except Exception as error:
            details = getattr(error, "details", None)
            if details is None and hasattr(error, "retryable"):
                details = {"retryable": error.retryable}
            detail = {"code": getattr(error, "code", "INTERNAL_ERROR"), "message": str(error)}
            if details is not None:
                detail["details"] = details
            reply = {"type": "crabot:rpc", "kind": "error", "id": message["id"], "error": detail}
        try:
            await self._send(reply)
        except (TypeError, ValueError):
            await self._send({"type": "crabot:rpc", "kind": "error", "id": message["id"],
                              "error": {"code": "INTERNAL_ERROR", "message": "Runtime result cannot be transferred"}})
        except PipeRpcError:
            pass
