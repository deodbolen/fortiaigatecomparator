import asyncio
import json
import os
import re
import time
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field


CONFIG_PATH = Path(__file__).resolve().parent.parent / "profiles.json"
PROFILES_DIR = Path(__file__).resolve().parent.parent / "profiles"
PROMPTS_DIR = Path(__file__).resolve().parent.parent / "prompts"

app = FastAPI(title="FortiAIGate Raw Comparator")

cors_origins = [
    origin.strip()
    for origin in os.getenv("CORS_ORIGINS", "*").split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatProxyRequest(BaseModel):
    base_url: str
    api_token: str = ""
    allow_self_signed: bool = False
    payload: dict[str, Any]
    request_headers: dict[str, str] = Field(default_factory=dict)


class ProfileRequest(BaseModel):
    name: str = "default"
    profile: dict[str, Any]


class PromptRequest(BaseModel):
    name: str
    prompt: str
    system_prompt: str = ""
    scenario: str = ""


def now_ms() -> float:
    return time.perf_counter() * 1000


def wall_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime()) + f".{int(time.time() * 1000) % 1000:03d}"


def sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def completion_url(base_url: str) -> str:
    normalized = base_url.rstrip("/") + "/"
    return urljoin(normalized, "v1/chat/completions")


def read_profiles() -> dict[str, Any]:
    if not CONFIG_PATH.exists():
        return {}
    return json.loads(CONFIG_PATH.read_text())


def write_profiles(data: dict[str, Any]) -> None:
    CONFIG_PATH.write_text(json.dumps(data, indent=2, sort_keys=True))


def file_slug(name: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_.-]+", "-", name.strip()).strip("-._")
    return slug[:80] or "item"


def prompt_slug(name: str) -> str:
    slug = file_slug(name)
    return slug if slug != "item" else "prompt"


def prompt_path(name: str) -> Path:
    return PROMPTS_DIR / f"{prompt_slug(name)}.json"


def profile_slug(name: str) -> str:
    slug = file_slug(name)
    return slug if slug != "item" else "profile"


def profile_path(name: str) -> Path:
    return PROFILES_DIR / f"{profile_slug(name)}.json"


def read_profile_files() -> list[dict[str, Any]]:
    PROFILES_DIR.mkdir(parents=True, exist_ok=True)
    profiles = []
    for path in sorted(PROFILES_DIR.glob("*.json")):
        try:
            data = json.loads(path.read_text())
            profiles.append(
                {
                    "id": path.stem,
                    "name": data.get("name", path.stem),
                    "profile": data.get("profile", {}),
                    "updated_at": data.get("updated_at"),
                }
            )
        except Exception:
            profiles.append({"id": path.stem, "name": path.stem, "profile": {}, "error": "Could not read profile file"})
    if CONFIG_PATH.exists() and not profiles:
        profiles.append({"id": "legacy", "name": "Legacy Profile", "profile": read_profiles(), "updated_at": None})
    return profiles


def write_profile_file(data: ProfileRequest) -> dict[str, Any]:
    PROFILES_DIR.mkdir(parents=True, exist_ok=True)
    saved = {
        "name": data.name.strip(),
        "profile": data.profile,
        "updated_at": wall_iso(),
    }
    path = profile_path(data.name)
    path.write_text(json.dumps(saved, indent=2, sort_keys=True))
    return {"id": path.stem, **saved}


def read_prompts() -> list[dict[str, Any]]:
    PROMPTS_DIR.mkdir(parents=True, exist_ok=True)
    prompts = []
    for path in sorted(PROMPTS_DIR.glob("*.json")):
        try:
            data = json.loads(path.read_text())
            prompts.append(
                {
                    "id": path.stem,
                    "name": data.get("name", path.stem),
                    "prompt": data.get("prompt", ""),
                    "system_prompt": data.get("system_prompt", ""),
                    "scenario": data.get("scenario", ""),
                    "updated_at": data.get("updated_at"),
                }
            )
        except Exception:
            prompts.append({"id": path.stem, "name": path.stem, "prompt": "", "error": "Could not read prompt file"})
    return prompts


def write_prompt(data: PromptRequest) -> dict[str, Any]:
    PROMPTS_DIR.mkdir(parents=True, exist_ok=True)
    saved = {
        "name": data.name.strip(),
        "prompt": data.prompt,
        "system_prompt": data.system_prompt,
        "scenario": data.scenario,
        "updated_at": wall_iso(),
    }
    path = prompt_path(data.name)
    path.write_text(json.dumps(saved, indent=2, sort_keys=True))
    return {"id": path.stem, **saved}


def delete_prompt_file(prompt_id: str) -> None:
    PROMPTS_DIR.mkdir(parents=True, exist_ok=True)
    path = PROMPTS_DIR / f"{file_slug(prompt_id)}.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Prompt not found")
    path.unlink()


def extract_content_from_json(payload: dict[str, Any]) -> str:
    try:
        choice = payload.get("choices", [{}])[0]
        message = choice.get("message") or {}
        if isinstance(message.get("content"), str):
            return message["content"]
        delta = choice.get("delta") or {}
        if isinstance(delta.get("content"), str):
            return delta["content"]
    except Exception:
        return ""
    return ""


def extract_content_from_sse_line(line: str) -> str:
    if not line.startswith("data:"):
        return ""
    raw = line[5:].strip()
    if raw == "[DONE]":
        return ""
    try:
        return extract_content_from_json(json.loads(raw))
    except Exception:
        return ""


def make_metrics(markers: dict[str, float | None], output_text: str) -> dict[str, Any]:
    request_start = markers.get("request_start")
    request_end = markers.get("request_end")
    first_byte = markers.get("first_byte")
    first_token = markers.get("first_token")
    final_token = markers.get("final_token")
    total_seconds = None
    if first_token is not None and final_token is not None and final_token >= first_token:
        total_seconds = max((final_token - first_token) / 1000, 0.001)

    estimated_tokens = max(len(output_text) / 4, 0)
    return {
        "request_start": request_start,
        "first_byte": first_byte,
        "first_token": first_token,
        "final_token": final_token,
        "request_end": request_end,
        "time_to_first_byte_ms": round(first_byte - request_start, 2) if first_byte and request_start else None,
        "time_to_first_token_ms": round(first_token - request_start, 2) if first_token and request_start else None,
        "total_latency_ms": round(request_end - request_start, 2) if request_end and request_start else None,
        "output_char_count": len(output_text),
        "estimated_tokens_per_second": round(estimated_tokens / total_seconds, 2) if total_seconds else None,
    }


async def emit_error(error: Exception, markers: dict[str, float | None], output_text: str):
    markers["request_end"] = now_ms()
    yield sse(
        "error",
        {
            "timestamp_ms": markers["request_end"],
            "timestamp": wall_iso(),
            "error_type": type(error).__name__,
            "message": str(error),
            "metrics": make_metrics(markers, output_text),
        },
    )


@app.get("/api/health")
async def health():
    return {"ok": True}


@app.get("/api/profile")
async def load_profile():
    profiles = read_profile_files()
    if profiles:
        return JSONResponse(profiles[0]["profile"])
    return JSONResponse(read_profiles())


@app.post("/api/profile")
async def save_profile(request: ProfileRequest):
    saved = write_profile_file(request)
    write_profiles(request.profile)
    return {"ok": True, "profile": saved}


@app.get("/api/profiles")
async def list_profiles():
    return JSONResponse({"profiles": read_profile_files()})


@app.post("/api/profiles")
async def save_named_profile(request: ProfileRequest):
    saved = write_profile_file(request)
    write_profiles(request.profile)
    return {"ok": True, "profile": saved}


@app.get("/api/prompts")
async def list_prompts():
    return JSONResponse({"prompts": read_prompts()})


@app.post("/api/prompts")
async def save_prompt(request: PromptRequest):
    saved = write_prompt(request)
    return {"ok": True, "prompt": saved}


@app.delete("/api/prompts/{prompt_id}")
async def delete_prompt(prompt_id: str):
    delete_prompt_file(prompt_id)
    return {"ok": True}


@app.post("/api/chat/stream")
async def chat_stream(request: Request):
    body = await request.json()
    chat_request = ChatProxyRequest.model_validate(body)
    url = completion_url(chat_request.base_url)
    payload = chat_request.payload
    stream_requested = bool(payload.get("stream", False))

    outbound_headers = {
        "Content-Type": "application/json",
        **chat_request.request_headers,
    }
    if chat_request.api_token:
        outbound_headers["Authorization"] = f"Bearer {chat_request.api_token}"

    async def generate():
        markers: dict[str, float | None] = {
            "request_start": now_ms(),
            "first_byte": None,
            "first_token": None,
            "final_token": None,
            "request_end": None,
        }
        output_text = ""
        chunk_index = 0
        upstream_line_buffer = ""

        yield sse(
            "request",
            {
                "timestamp_ms": markers["request_start"],
                "timestamp": wall_iso(),
                "method": "POST",
                "url": url,
                "headers": outbound_headers,
                "payload": payload,
            },
        )

        try:
            timeout = httpx.Timeout(connect=20.0, read=None, write=60.0, pool=20.0)
            async with httpx.AsyncClient(timeout=timeout, verify=not chat_request.allow_self_signed) as client:
                if stream_requested:
                    async with client.stream("POST", url, headers=outbound_headers, json=payload) as response:
                        markers["first_byte"] = now_ms()
                        yield sse(
                            "response_headers",
                            {
                                "timestamp_ms": markers["first_byte"],
                                "timestamp": wall_iso(),
                                "status_code": response.status_code,
                                "headers": dict(response.headers),
                            },
                        )

                        async for raw_chunk in response.aiter_text():
                            arrived = now_ms()
                            if markers["first_byte"] is None:
                                markers["first_byte"] = arrived
                            if raw_chunk:
                                upstream_line_buffer += raw_chunk
                                lines = upstream_line_buffer.splitlines(keepends=True)
                                if lines and not lines[-1].endswith(("\n", "\r")):
                                    upstream_line_buffer = lines.pop()
                                else:
                                    upstream_line_buffer = ""
                                for line in lines:
                                    token = extract_content_from_sse_line(line.rstrip("\r\n"))
                                    if token:
                                        if markers["first_token"] is None:
                                            markers["first_token"] = arrived
                                        markers["final_token"] = arrived
                                        output_text += token
                                yield sse(
                                    "chunk",
                                    {
                                        "timestamp_ms": arrived,
                                        "timestamp": wall_iso(),
                                        "index": chunk_index,
                                        "raw": raw_chunk,
                                        "output_so_far": output_text,
                                    },
                                )
                                chunk_index += 1
                            await asyncio.sleep(0)
                else:
                    response = await client.post(url, headers=outbound_headers, json=payload)
                    markers["first_byte"] = now_ms()
                    yield sse(
                        "response_headers",
                        {
                            "timestamp_ms": markers["first_byte"],
                            "timestamp": wall_iso(),
                            "status_code": response.status_code,
                            "headers": dict(response.headers),
                        },
                    )
                    raw_body = response.text
                    arrived = now_ms()
                    try:
                        output_text = extract_content_from_json(response.json())
                    except Exception:
                        output_text = raw_body
                    if output_text:
                        markers["first_token"] = arrived
                        markers["final_token"] = arrived
                    yield sse(
                        "chunk",
                        {
                            "timestamp_ms": arrived,
                            "timestamp": wall_iso(),
                            "index": chunk_index,
                            "raw": raw_body,
                            "output_so_far": output_text,
                        },
                    )

            markers["request_end"] = now_ms()
            yield sse(
                "done",
                {
                    "timestamp_ms": markers["request_end"],
                    "timestamp": wall_iso(),
                    "output": output_text,
                    "metrics": make_metrics(markers, output_text),
                },
            )
        except Exception as error:
            async for item in emit_error(error, markers, output_text):
                yield item

    return StreamingResponse(generate(), media_type="text/event-stream")
