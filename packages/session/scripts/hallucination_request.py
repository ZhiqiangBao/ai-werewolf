#!/usr/bin/env python3
"""Send one semantic hallucination-check request and print normalized JSON."""
import json
import sys
import time
import urllib.error
import urllib.request


def schema_param(param):
    kind = param.get("kind")
    if kind == "seat":
        values = list(param.get("options", []))
        if param.get("nullable"):
            values.append(None)
        return {"type": ["integer", "null"] if param.get("nullable") else "integer", "enum": values, "description": param.get("label", "")}
    if kind == "seats":
        return {"type": "array", "items": {"type": "integer", "enum": param.get("options", [])}, "minItems": param.get("min", 0), "maxItems": param.get("max", 0), "uniqueItems": True, "description": param.get("label", "")}
    if kind == "boolean":
        return {"type": "boolean", "description": param.get("label", "")}
    if kind == "choice":
        return {"type": "string", "enum": [item.get("value") for item in param.get("options", [])], "description": param.get("label", "")}
    return {"type": "string", "description": param.get("label", "")}


def tool_schema(tool):
    params = tool.get("params", [])
    return {"type": "object", "properties": {p["name"]: schema_param(p) for p in params}, "required": [p["name"] for p in params], "additionalProperties": False}


def chat_messages(messages):
    result = []
    for message in messages:
        role = message["role"]
        if role == "tool":
            result.append({"role": "tool", "tool_call_id": message.get("callId", ""), "content": message.get("content", "")})
        elif role == "assistant":
            item = {"role": "assistant", "content": message.get("content") or ""}
            calls = message.get("calls", [])
            if calls:
                item["tool_calls"] = [{"id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": c["arguments"]}} for c in calls]
            result.append(item)
        else:
            item = {"role": role, "content": message.get("content", "")}
            if message.get("name"):
                item["content"] = f"[{message['name']}]\n{item['content']}"
            result.append(item)
    return result


def response_input(messages):
    result = []
    for message in messages:
        if message["role"] == "system":
            result.append({"role": "system", "content": message.get("content", "")})
        elif message["role"] == "tool":
            result.append({"type": "function_call_output", "call_id": message.get("callId", ""), "output": message.get("content", "")})
        elif message["role"] == "assistant":
            if message.get("content"):
                result.append({"role": "assistant", "content": message["content"]})
            for call in message.get("calls", []):
                result.append({"type": "function_call", "call_id": call["id"], "name": call["name"], "arguments": call["arguments"]})
        else:
            result.append({"role": "user", "content": f"[{message['name']}]\n{message['content']}" if message.get("name") else message.get("content", "")})
    return result


def anthropic_messages(messages):
    system = []
    turns = []
    for message in messages:
        if message["role"] == "system":
            system.append({"type": "text", "text": message.get("content", "")})
            continue
        role = "assistant" if message["role"] == "assistant" else "user"
        content = []
        if message["role"] == "tool":
            content.append({"type": "tool_result", "tool_use_id": message.get("callId", ""), "content": message.get("content", "")})
        elif message["role"] == "assistant":
            if message.get("content"):
                content.append({"type": "text", "text": message["content"]})
            for call in message.get("calls", []):
                try:
                    arguments = json.loads(call["arguments"] or "{}")
                except json.JSONDecodeError:
                    arguments = {}
                content.append({"type": "tool_use", "id": call["id"], "name": call["name"], "input": arguments})
        else:
            content.append({"type": "text", "text": f"[{message['name']}]\n{message['content']}" if message.get("name") else message.get("content", "")})
        if turns and turns[-1]["role"] == role:
            turns[-1]["content"].extend(content)
        else:
            turns.append({"role": role, "content": content})
    return system, turns


def build_body(request):
    protocol = request["protocol"]
    tools = [{"name": t["name"], "title": t.get("title", ""), "description": t.get("description", ""), "parameters": tool_schema(t)} for t in request.get("tools", [])]
    choice = "auto" if request.get("tool_choice") == "auto" else "required"
    if protocol == "chat_completions":
        body = {"model": request["model"], "messages": chat_messages(request["messages"]), "temperature": request.get("temperature", 0.7), "tools": [{"type": "function", "function": {"name": t["name"], "description": t["description"], "parameters": t["parameters"]}} for t in tools], "tool_choice": choice}
        if request.get("max_output_tokens"):
            body["max_completion_tokens"] = request["max_output_tokens"]
        return body, {"Authorization": f"Bearer {request['api_key']}"} if request.get("api_key") else {}
    if protocol == "responses":
        body = {"model": request["model"], "input": response_input(request["messages"]), "store": False, "tools": [{"type": "function", "name": t["name"], "description": t["description"], "parameters": t["parameters"], "strict": True} for t in tools], "tool_choice": choice, "parallel_tool_calls": False}
        if request.get("max_output_tokens"):
            body["max_output_tokens"] = request["max_output_tokens"]
        return body, {"Authorization": f"Bearer {request['api_key']}"} if request.get("api_key") else {}
    system, messages = anthropic_messages(request["messages"])
    body = {"model": request["model"], "max_tokens": request.get("max_output_tokens") or 4096, "system": system, "messages": messages, "tools": [{"name": t["name"], "description": t["description"], "input_schema": t["parameters"]} for t in tools], "tool_choice": {"type": "auto", "disable_parallel_tool_use": True}}
    headers = {"anthropic-version": "2023-06-01"}
    if request.get("api_key"):
        headers["x-api-key"] = request["api_key"]
    return body, headers


def parse_output(protocol, data):
    text = ""
    call = None
    if protocol == "chat_completions":
        message = (data.get("choices") or [{}])[0].get("message") or {}
        text = message.get("content") or ""
        calls = message.get("tool_calls") or []
        if calls:
            function = calls[0].get("function") or {}
            try:
                arguments = json.loads(function.get("arguments") or "{}")
            except json.JSONDecodeError:
                arguments = {}
            call = {"tool": function.get("name", ""), "args": arguments}
    elif protocol == "responses":
        for item in data.get("output") or []:
            if item.get("type") == "message":
                text += "".join(part.get("text", "") for part in item.get("content") or [] if part.get("type") in ("output_text", "text"))
            if item.get("type") == "function_call" and call is None:
                try:
                    arguments = json.loads(item.get("arguments") or "{}")
                except json.JSONDecodeError:
                    arguments = {}
                call = {"tool": item.get("name", ""), "args": arguments}
    else:
        for block in data.get("content") or []:
            if block.get("type") == "text":
                text += block.get("text", "")
            if block.get("type") == "tool_use" and call is None:
                call = {"tool": block.get("name", ""), "args": block.get("input") or {}}
    return text, call


def emit_result(value):
    sys.stdout.buffer.write(json.dumps(value, ensure_ascii=False).encode("utf-8"))
    sys.stdout.buffer.write(b"\n")


def main():
    started = time.time()
    try:
        request = json.loads(sys.stdin.buffer.read().decode("utf-8"))
        body, headers = build_body(request)
        encoded = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
        req = urllib.request.Request(request["endpoint"], data=encoded, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=float(request.get("timeout", 90))) as response:
            data = json.loads(response.read().decode("utf-8"))
        text, call = parse_output(request["protocol"], data)
        result = {"status": "completed", "text": text, "latencyMs": round((time.time() - started) * 1000), "responseModel": data.get("model")}
        if call is not None:
            result["call"] = call
        emit_result(result)
    except urllib.error.HTTPError as exc:
        try:
            body = exc.read().decode("utf-8", errors="replace")[:1000]
        except Exception:
            body = ""
        emit_result({"status": "failed", "failureKind": "http", "error": f"HTTP {exc.code} {exc.reason}: {body}", "text": "", "latencyMs": round((time.time() - started) * 1000)})
    except urllib.error.URLError as exc:
        emit_result({"status": "failed", "failureKind": "network", "error": f"URL error: {exc.reason}", "text": "", "latencyMs": round((time.time() - started) * 1000)})
    except TimeoutError:
        emit_result({"status": "failed", "failureKind": "timeout", "error": "Request timed out", "text": "", "latencyMs": round((time.time() - started) * 1000)})
    except Exception as exc:
        emit_result({"status": "failed", "failureKind": "network", "error": f"{type(exc).__name__}: {exc}", "text": "", "latencyMs": round((time.time() - started) * 1000)})


if __name__ == "__main__":
    main()
