#!/usr/bin/env python3
"""One sentence -> one playable single-level world (standalone toolkit).

Stages:
  1. seed      : the LLM turns your sentence into a structured world seed
  2. character : one character portrait image (optional; needs an image API)
  3. level     : the LLM turns the seed into the level JSON (scenes, endings)
  4. prompts   : build the image requirement list (prompts.json)
  5. images    : batch-generate cover / scene / outcome / ending art (optional)
  6. assemble  : write worlds/<slug>/world.json (+ en sidecar) and the entry page

Everything is cached per stage: rerunning skips finished work, so iteration is cheap.

Configuration (all optional; environment variables):
  GLIMMERS_LLM_BASE    any OpenAI-compatible endpoint, default https://api.deepseek.com
  GLIMMERS_LLM_KEY     your own API key
  GLIMMERS_LLM_MODEL   default deepseek-chat (comma-separated list = fallback chain)
  GLIMMERS_IMAGE_BASE  optional images endpoint; without it the world is text-only
  GLIMMERS_IMAGE_KEY   image API key
  GLIMMERS_IMAGE_MODEL default gpt-image-1

Example:
    python3 tools/generate_world.py --sentence "做一个猫猫勇者战胜邪恶魔王的小游戏"
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from html import escape
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
W = ROOT / "worlds"
WORK = ROOT / "artifacts" / "oneshot"
TEMPLATE = ROOT / "tools" / "player-template.html"

LLM_BASE = os.environ.get("GLIMMERS_LLM_BASE", "https://api.deepseek.com").strip().rstrip("/")
LLM_KEY = os.environ.get("GLIMMERS_LLM_KEY", "").strip()
LLM_MODEL = os.environ.get("GLIMMERS_LLM_MODEL", "deepseek-chat").strip() or "deepseek-chat"
IMAGE_BASE = os.environ.get("GLIMMERS_IMAGE_BASE", "").strip().rstrip("/")
IMAGE_KEY = os.environ.get("GLIMMERS_IMAGE_KEY", "").strip()
IMAGE_MODEL = os.environ.get("GLIMMERS_IMAGE_MODEL", "gpt-image-1").strip() or "gpt-image-1"
IMAGE_EXTRA = os.environ.get("GLIMMERS_IMAGE_EXTRA", "").strip()
PLAY_BASE = os.environ.get("GLIMMERS_PLAY_BASE", "http://127.0.0.1:8096").rstrip("/")
CALLS = 0


def rel(path) -> str:
    """Logs and API payloads use paths relative to the project root (no usernames)."""
    try:
        return str(Path(path).resolve().relative_to(ROOT))
    except ValueError:
        return str(path)


def tls_context():
    """Prefer a certifi-verified TLS context; only fall back to the local workaround if needed."""
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except Exception:  # noqa: BLE001 - certifi missing on some machines
        return ssl._create_unverified_context()


SSL_CONTEXT = tls_context()


# 一次真实 AI 调用的计数（文字 LLM / 一张图），只用于结果展示，不做额度限制。
def count_call(label: str = "") -> None:
    global CALLS
    CALLS += 1


STAGES = ["seed", "character", "level", "prompts", "images", "assemble"]

DEFAULT_STYLE = (
    "Studio Ghibli style animation film still, hand-painted background, soft natural light, "
    "warm nostalgic palette, gentle storybook illustration, clean composition, "
    "no text, no lettering, no signage, no watermark, no UI"
)
TRUTH_STYLE = (
    "restrained realistic illustration, muted desaturated palette, cold flat daylight, "
    "documentary honesty, no fantasy sparkle, no embellishment, "
    "no text, no lettering, no signage, no watermark"
)
NO_TEXT = (
    "画面里绝对不要出现任何文字：不要中文、不要英文字母、不要数字，不要招牌、站牌、横幅、"
    "旗帜、衣服或车辆上的字，不要对话气泡；并且不要画出任何标牌、站牌、指示牌或牌子"
    "（宁可画空墙、空柱子，也不要出现牌子）。"
)
# ---------------------------------------------------------------- LLM helpers
def llm(prompt: str, models: list[str] | None = None) -> str:
    """Call an OpenAI-compatible chat endpoint with a small retry / fallback chain."""
    if not LLM_KEY:
        raise RuntimeError("missing API key: fill the key field in the page, or set GLIMMERS_LLM_KEY")
    chain = models or [name.strip() for name in LLM_MODEL.split(",") if name.strip()]
    last = None
    for model in chain:
        for attempt in range(2):
            try:
                count_call(f"llm:{model}")
                return _chat_completion(model, prompt)
            except Exception as error:  # noqa: BLE001
                last = error
                time.sleep(2 * (attempt + 1))
        print(f"    [llm] {model} unavailable: {str(last)[:100]}")
    raise RuntimeError(f"all models failed: {last}")


def _http_json(url: str, payload: dict, key: str, timeout: int = 600) -> dict:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout, context=SSL_CONTEXT) as response:
        return json.loads(response.read())


def _chat_completion(model: str, prompt: str) -> str:
    """OpenAI-compatible /chat/completions; providers without it fall back to /responses."""
    try:
        data = _http_json(
            f"{LLM_BASE}/chat/completions",
            {"model": model, "messages": [{"role": "user", "content": prompt}], "stream": False},
            LLM_KEY,
        )
    except urllib.error.HTTPError as error:
        if error.code in (404, 405):
            return _responses_call(model, prompt)
        raise
    if data.get("error"):
        raise RuntimeError(f"endpoint error: {json.dumps(data['error'], ensure_ascii=False)[:200]}")
    choice = (data.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    content = message.get("content")
    if isinstance(content, list):  # some gateways use Anthropic-style content blocks
        content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
    content = content if isinstance(content, str) else ""
    if not content.strip():
        # 有些网关偶尔回空内容：换一条通道再试一次，随后交给上层重试。
        return _responses_call(model, prompt)
    return content


def _responses_call(model: str, prompt: str) -> str:
    data = _http_json(f"{LLM_BASE}/responses", {"model": model, "input": prompt}, LLM_KEY)
    for item in data.get("output", []):
        if item.get("type") != "message":
            continue
        for piece in item.get("content", []):
            if piece.get("type") == "output_text" and piece.get("text"):
                return piece["text"]
    raise RuntimeError(f"unexpected responses payload: {json.dumps(data, ensure_ascii=False)[:200]}")


def extract_json(text: str) -> dict:
    text = text.strip()
    text = re.sub(r"^```(?:json)?|```$", "", text, flags=re.M).strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError(f"no JSON object in reply: {text[:200]}")
    return json.loads(text[start : end + 1])


def llm_json(prompt: str, validator=None, attempts: int = 4) -> dict:
    last_error = ""
    for attempt in range(1, attempts + 1):
        suffix = "" if not last_error else f"\n\n上一次的输出有问题：{last_error}\n请修正后只输出 JSON。"
        reply = llm(prompt + suffix)
        try:
            data = extract_json(reply)
            if validator:
                validator(data)
            return data
        except Exception as error:  # noqa: BLE001
            last_error = str(error)
            print(f"    [llm] attempt {attempt} rejected: {last_error[:160]}")
            time.sleep(2)
    raise RuntimeError(f"LLM did not produce valid JSON: {last_error}")


# ------------------------------------------------------------- image helpers
def gen_image(prompt: str, output: Path, reference: Path | None = None) -> str:
    """One picture via an optional OpenAI-compatible images endpoint.

    No image endpoint configured -> skipped (the world is still generated and
    playable; image slots simply stay empty). `reference` is kept for pipeline
    compatibility and is ignored by the plain images API.
    """
    if output.is_file():
        return f"skip {output.name}"
    if not (IMAGE_BASE and IMAGE_KEY):
        return f"skip {output.name} (no image API configured)"
    payload = {"model": IMAGE_MODEL, "prompt": prompt, "n": 1}
    extra = None
    if IMAGE_EXTRA:
        try:
            extra = json.loads(IMAGE_EXTRA)
        except ValueError:
            extra = None
    if isinstance(extra, dict) and extra:
        payload.update(extra)
    else:
        payload["size"] = "1024x1024"
    last = None
    for attempt in range(3):
        try:
            count_call("image")
            data = _http_json(f"{IMAGE_BASE}/images/generations", payload, IMAGE_KEY, timeout=300)
            item = (data.get("data") or [{}])[0]
            output.parent.mkdir(parents=True, exist_ok=True)
            if item.get("b64_json"):
                output.write_bytes(base64.b64decode(item["b64_json"]))
            elif item.get("url"):
                with urllib.request.urlopen(item["url"], timeout=300, context=SSL_CONTEXT) as response:
                    output.write_bytes(response.read())
            else:
                raise RuntimeError(f"no image payload: {json.dumps(data, ensure_ascii=False)[:200]}")
            return f"ok {output.name}"
        except Exception as error:  # noqa: BLE001
            last = error
            time.sleep(4 * (attempt + 1))
    return f"FAILED {output.name}: {last}"


# ------------------------------------------------------------------- stages
SEED_PROMPT = """你是《异境拾光》的关卡策划。用户会给一句话主题，你要把它扩写成一个小世界的"设定卡"。

要求：
- 主角按主题决定：主题是动物就用动物（猫优先），主题明确是"小孩/老人/某种人"就用对应的人。
- 如果主题涉及战争、死亡、暴力：全部用暗示与幻想处理，不出现血腥、尸体或直接的伤害画面。
- 故事是一个完整的小关卡：开始 → 若干事件 → 结局；风格温暖、有想象力，适合全年龄。
- 状态 2-3 个（例如勇气/机智/羁绊），每个 0-12 的整数。
- 场景数默认 8；结局数默认 3（其中 1 个是"失败/平凡"的兜底结局）。
- slug 用英文小写字母和短横线，3-32 字符。

只输出 JSON，不要解释。格式：
{
  "slug": "cat-hero-demon-king",
  "title": "猫猫勇者与魔王",
  "titleEn": "The Cat Hero and the Demon King",
  "subtitle": "一爪一爪打到魔王城",
  "subtitleEn": "One paw at a time",
  "description": "两句以内的简介",
  "descriptionEn": "Two sentences at most",
  "premise": "一句话故事前提（中文）",
  "character": {
    "name": "主角名",
    "species": "主角是什么（例如：橘猫 / 八岁男孩 / 老妇人）",
    "look": "外观：颜色/体型/特征/常用装备（中文一句）",
    "personality": "性格（中文一句）"
  },
  "fantasy_filter": "可选：如果主题要求'幻想/美化/最后揭露真相'，写清楚主角把残酷的现实美化成了什么；否则省略这个字段",
  "truth": "可选：与 fantasy_filter 相对的真相（克制、不血腥）；没有就省略",
  "reveal_style": "可选：揭露真相时使用的英文画风（冷、写实、克制，结尾包含 no text）；没有就省略",
  "style_suffix": "英文画风描述，用于图像生成，结尾包含 no text",
  "palette": ["#8ab4f8", "#f2d6a0", "#3f4a5a"],
  "states": [
    {"id": "courage", "label": "勇气", "labelEn": "Courage", "initial": 1, "max": 12, "description": "面对危险还敢往前冲的程度"}
  ],
  "scene_count": 8,
  "ending_count": 3
}

用户的一句话主题是："""

LEVEL_PROMPT = """你是《异境拾光》的关卡编剧。根据"设定卡"，写出一整个单关卡世界的剧情 JSON。

硬性规则：
- scenes 数量 = scene_count；每关 3 个选项（actions），每个选项都要有对应的 result（outcomes）。
- 选项文本 <= 14 个汉字；结果文本 <= 34 个汉字；场景描述 <= 46 个汉字；所有文本都要简短（会显示在手机屏幕上）。
- 每个选项的 stateChanges 只能引用设定卡里的 state id，数值在 -2..+2。
- endings 数量 = ending_count；最后一个结局必须是兜底：{ "all": [] }。
- 结局触发条件引用 state id，操作符用 ">=" 或 ">"。
- 如果设定卡里有 "truth"：剧情里不直接点破真相；每个结局的文本都必须把真相带出来（克制、不血腥），最后一关的选项结果只留克制的伏笔。
- 没有音乐、没有目录、没有关卡选择界面；就是一个连贯的小关卡。
- 只输出 JSON，不要解释。

输出格式（严格照抄结构，把内容换成你的故事）：
{
  "scenes": [
    {
      "id": "scene-01",
      "title": "标题",
      "titleEn": "Title",
      "description": "场景描述",
      "descriptionEn": "Short English description",
      "actions": [
        {"id": "a1", "name": "选项一", "nameEn": "Option 1", "hint": "短提示", "hintEn": "short hint", "icon": "A"},
        {"id": "a2", "name": "选项二", "nameEn": "Option 2", "hint": "短提示", "hintEn": "short hint", "icon": "B"},
        {"id": "a3", "name": "选项三", "nameEn": "Option 3", "hint": "短提示", "hintEn": "short hint", "icon": "C"}
      ],
      "outcomes": {
        "a1": {"text": "结果", "textEn": "Short result", "stateChanges": {"courage": 1}},
        "a2": {"text": "结果", "textEn": "Short result", "stateChanges": {}},
        "a3": {"text": "结果", "textEn": "Short result", "stateChanges": {"courage": -1}}
      }
    }
  ],
  "endings": [
    {"id": "ending-hero", "title": "结局标题", "titleEn": "Ending", "description": "结局文本", "descriptionEn": "Ending text", "all": [{"state": "courage", "operator": ">=", "value": 7}]},
    {"id": "ending-ordinary", "title": "兜底结局", "titleEn": "Fallback", "description": "结局文本", "descriptionEn": "Ending text", "all": []}
  ]
}

设定卡：
"""


def stage_seed(sentence: str, work: Path, style: str | None = None) -> dict:
    path = work / "world_seed.json"
    if path.is_file():
        print("[1/6] seed cached")
        return json.loads(path.read_text(encoding="utf-8"))
    print("[1/6] seed: asking the LLM ...")

    def validate(data):
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{2,31}", str(data.get("slug", ""))):
            raise ValueError("slug must be lowercase letters/digits/dashes (3-32)")
        if not data.get("title") or not data.get("character", {}).get("look"):
            raise ValueError("title/character.look required")
        if not isinstance(data.get("states"), list) or not 2 <= len(data["states"]) <= 3:
            raise ValueError("2-3 states required")

    data = llm_json(SEED_PROMPT + sentence, validator=validate)
    # 用户没指定风格时，统一用吉卜力默认风格；LLM 的题材氛围只作为后缀补充。
    flavor = str(data.get("style_suffix") or "").strip()
    if style:
        data["style_suffix"] = style
    elif flavor and flavor.lower() not in DEFAULT_STYLE.lower() and len(flavor) <= 140:
        data["style_suffix"] = f"{DEFAULT_STYLE}, {flavor}"
    else:
        data["style_suffix"] = DEFAULT_STYLE
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"        slug={data['slug']} | title={data['title']}")
    return data


def character_prompt(seed: dict) -> str:
    c = seed["character"]
    species = c.get("species") or "cat"
    return (
        f"{seed['style_suffix']}. Character design of {c['name']}, {species}: {c['look']}. "
        f"Personality: {c['personality']}. Single character, full body, three-quarter view, "
        f"plain soft warm background, clean and charming. {NO_TEXT}"
    )


def stage_character(seed: dict, work: Path) -> Path:
    path = work / "character.png"
    print("[2/6] character: generating the anchor portrait ...")
    print("       " + gen_image(character_prompt(seed), path))
    return path


def stage_level(seed: dict, work: Path) -> dict:
    path = work / "level.json"
    if path.is_file():
        print("[3/6] level cached")
        return json.loads(path.read_text(encoding="utf-8"))
    print("[3/6] level: writing the scenes ...")

    def validate(data):
        scenes = data.get("scenes")
        endings = data.get("endings")
        if not isinstance(scenes, list) or len(scenes) != int(seed["scene_count"]):
            raise ValueError(f"scenes must be {seed['scene_count']}")
        state_ids = {s["id"] for s in seed["states"]}
        for scene in scenes:
            if len(scene.get("actions", [])) != 3:
                raise ValueError(f"{scene.get('id')} needs 3 actions")
            if len(scene.get("description", "")) > 46:
                raise ValueError(f"{scene['id']} description longer than 46 chars")
            for action in scene["actions"]:
                if len(action.get("name", "")) > 14:
                    raise ValueError(f"{scene['id']}/{action['id']} name longer than 14 chars")
                if action["id"] not in scene.get("outcomes", {}):
                    raise ValueError(f"{scene['id']}/{action['id']} has no outcome")
                if len(scene["outcomes"][action["id"]].get("text", "")) > 34:
                    raise ValueError(f"{scene['id']}/{action['id']} outcome longer than 34 chars")
            for outcome in scene["outcomes"].values():
                for key, value in (outcome.get("stateChanges") or {}).items():
                    if key not in state_ids:
                        raise ValueError(f"unknown state {key}")
                    if not isinstance(value, int) or not -2 <= value <= 2:
                        raise ValueError(f"{scene['id']} state change {key}={value} outside -2..2")
        if not isinstance(endings, list) or len(endings) != int(seed["ending_count"]):
            raise ValueError(f"endings must be {seed['ending_count']}")
        if endings and endings[-1].get("all"):
            raise ValueError("last ending must be unconditional")

    data = llm_json(LEVEL_PROMPT + json.dumps(seed, ensure_ascii=False, indent=2), validator=validate)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"        scenes={len(data['scenes'])} endings={len(data['endings'])}")
    return data


def build_prompts(seed: dict, level: dict, work: Path) -> list[dict]:
    """Every image the world needs, with the frozen style suffix + character."""
    c = seed["character"]
    base = f"{seed['style_suffix']}. {c['name']} the cat: {c['look']}. "
    if seed.get("character", {}).get("species") and "猫" not in str(c.get("species")):
        base = f"{seed['style_suffix']}. {c['name']}: {c['look']}. "
    truth = seed.get("truth")
    fantasy = seed.get("fantasy_filter")
    truth_style = seed.get("reveal_style") or TRUTH_STYLE
    fantasy_clause = f"画面是主角幻想中美化的世界（{fantasy}），不要出现真实的战争画面。 " if truth else ""
    reveal_clause = (
        f"这一格要揭露真相：{truth}。克制、不血腥、不出现尸体；"
        f"不要出现国旗、军队或组织徽章，人物衣服上没有文字和编号。 "
    ) if truth else ""
    ref = "character.png"
    jobs: list[dict] = [{
        "kind": "cover", "path": "assets/cover.png", "ref": ref,
        "prompt": f"{base}参考图只用来确认主角的样子；请画一个全新的海报构图，不要重复参考图的背景或姿势：{seed['premise']} {fantasy_clause}{NO_TEXT}",
    }]
    # 幻想/真相类主题：所有过程图都保持"主角幻想中美化过的世界"，真相只在结局图里揭露。
    for scene in level["scenes"]:
        jobs.append({
            "kind": "scene", "path": f"assets/images/scenes/{scene['id']}.png", "ref": ref,
            "prompt": f"{base}场景：{scene['description']} {fantasy_clause}{NO_TEXT}",
        })
        for action in scene["actions"]:
            outcome = scene["outcomes"][action["id"]]
            jobs.append({
                "kind": "outcome", "path": f"assets/images/outcomes/{scene['id']}-{action['id']}.png", "ref": ref,
                "prompt": f"{base}参考图只用来确认主角的样子；请画一个全新的场景与构图（不要重复参考图的背景）：动作「{action['name']}」，结果：{outcome['text']} {fantasy_clause}{NO_TEXT}",
            })
    for ending in level["endings"]:
        jobs.append({
            "kind": "ending", "path": f"assets/images/endings/{ending['id']}.png", "ref": None if truth else ref,
            "prompt": (f"{truth_style}. {c['name']}: {c['look']}. {reveal_clause}" if truth else f"{base}")
            + f"结局画面（标题只作剧情说明，不要把它写进画面）：{ending['title']}。{ending['description']} {NO_TEXT}",
        })
    path = work / "prompts.json"
    path.write_text(json.dumps(jobs, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"[4/6] prompts: {len(jobs)} images -> {path.name}")
    return jobs


def stage_images(seed: dict, jobs: list[dict], work: Path, workers: int) -> list[str]:
    print(f"[5/6] images: generating {len(jobs)} pictures ({workers} workers) ...")
    reference = work / "character.png"
    world_dir = W / seed["slug"]
    results: list[str] = []

    def run(job):
        output = world_dir / job["path"]
        ref = reference if job.get("ref") else None
        message = gen_image(job["prompt"], output, reference=ref)
        return f"{job['kind']:8} {message}"

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for index, message in enumerate(pool.map(run, jobs), start=1):
            results.append(message)
            print(f"        [{index}/{len(jobs)}] {message}", flush=True)
    return results


def split_en(payload: dict) -> dict:
    if isinstance(payload, list):
        return [split_en(item) for item in payload]
    if isinstance(payload, dict):
        out = {}
        for key, value in payload.items():
            if key.endswith("En"):
                out[key[:-2]] = split_en(value)
            elif f"{key}En" in payload:
                continue
            else:
                out[key] = split_en(value)
        return out
    return payload


def stage_assemble(seed: dict, level: dict, work: Path, keepsakes: list[dict] | None = None, in_catalog: bool = False) -> dict:
    print("[6/6] assemble: writing the world ...")
    slug = seed["slug"]
    palette = seed.get("palette") or ["#8ab4f8", "#f2d6a0", "#3f4a5a"]
    states = []
    for index, state in enumerate(seed["states"]):
        states.append({
            "id": state["id"], "label": state["label"], "labelEn": state.get("labelEn", state["label"]),
            "description": state.get("description", ""),
            "color": palette[index % len(palette)], "chipBackground": "#eef2f7",
            "max": int(state.get("max", 12)),
        })
    scenes = []
    for order, scene in enumerate(level["scenes"], start=1):
        actions = []
        outcomes = {}
        for action in scene["actions"]:
            actions.append({
                "id": action["id"], "name": action["name"], "nameEn": action.get("nameEn", action["name"]),
                "hint": action.get("hint", ""), "hintEn": action.get("hintEn", action.get("hint", "")),
                "icon": action.get("icon") or chr(64 + len(actions) + 1),
            })
            outcome = scene["outcomes"][action["id"]]
            outcomes[action["id"]] = {
                "text": outcome["text"], "textEn": outcome.get("textEn", outcome["text"]),
                "stateChanges": outcome.get("stateChanges") or {},
                "image": f"assets/images/outcomes/{scene['id']}-{action['id']}.png",
            }
        scenes.append({
            "id": scene["id"], "chapter": f"第 {order} 关", "chapterEn": f"Stage {order}",
            "title": scene["title"], "titleEn": scene.get("titleEn", scene["title"]),
            "description": scene["description"], "descriptionEn": scene.get("descriptionEn", scene["description"]),
            "image": f"assets/images/scenes/{scene['id']}.png",
            "actions": actions, "outcomes": outcomes,
        })
    endings = []
    for ending in level["endings"]:
        endings.append({
            "id": ending["id"], "title": ending["title"], "titleEn": ending.get("titleEn", ending["title"]),
            "description": ending["description"], "descriptionEn": ending.get("descriptionEn", ending["description"]),
            "all": ending.get("all") or [], "image": f"assets/images/endings/{ending['id']}.png",
        })
    payload = {
        "id": slug,
        "title": seed["title"], "titleEn": seed.get("titleEn", seed["title"]),
        "shortTitle": seed["title"], "shortTitleEn": seed.get("titleEn", seed["title"]),
        "subtitle": seed.get("subtitle", ""), "subtitleEn": seed.get("subtitleEn", ""),
        "description": seed.get("description", ""), "descriptionEn": seed.get("descriptionEn", ""),
        "mode": None,
        "shuffleActions": False,
        "assetBase": f"worlds/{slug}/",
        "cover": {"default": "assets/cover.png"},
        # 有封面图就用封面；纯文本世界（没配图片接口）改成标题+简介的兜底开场。
        "opening": {"mode": "image", "image": "assets/cover.png"} if (W / slug / "assets" / "cover.png").is_file() else {"mode": "none"},
        "initialState": {state["id"]: int(state.get("initial", 0)) for state in seed["states"]},
        "states": states,
        # 顶层 actions：目录卡的中文摘要行用它（不参与玩法；玩法用每关自带的三个选项）。
        "actions": [{"id": state["id"], "name": state["label"], "plain": state["label"], "icon": "✦"}
                    for state in seed["states"]],
        "characters": [{"id": "hero", "name": seed["character"]["name"], "nameEn": seed["character"]["name"],
                         "role": "hero", "strength": 5, "agility": 5}],
        "scenes": scenes,
        "endings": endings,
        "keepsakes": keepsakes or [],
        "catalog": {
            "eyebrow": "新的异境微光已经苏醒",
            "cardDescription": seed.get("description", ""),
            "cardIcon": "✦",
            "cardGradient": (palette + ["#8172c3", "#44346e", "#28203f"])[:3],
            "cardAccent": palette[-1],
            "actionSummary": " · ".join(state["label"] for state in seed["states"]),
            "actionSummaryEn": " · ".join(state.get("labelEn", state["label"]) for state in seed["states"]),
        },
        "ui": {
            "backToCatalog": "← 返回目录", "backToCatalogEn": "← Worlds",
            "introButton": "开始冒险", "introButtonEn": "Begin the adventure",
            "continueButton": "继续", "continueButtonEn": "Continue",
            "finalContinueButton": "看看结局", "finalContinueButtonEn": "See the ending",
            "replayButton": "再冒险一次", "replayButtonEn": "Adventure again",
            "hideBackToCatalog": True,
        },
    }
    world_dir = W / slug
    world_dir.mkdir(parents=True, exist_ok=True)
    (world_dir / "world.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (world_dir / "i18n").mkdir(exist_ok=True)
    (world_dir / "i18n" / "en.json").write_text(json.dumps(split_en(payload), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    # 目录记录：默认 hidden（只留独立入口页给分享）；--in-catalog 时进主目录。
    index_path = W / "index.json"
    catalog = json.loads(index_path.read_text(encoding="utf-8"))
    entry = {
        "id": slug, "config": f"{slug}/world.json", "status": "ready",
        "title": seed["title"], "titleEn": seed.get("titleEn", seed["title"]),
        "subtitleEn": seed.get("subtitleEn", seed.get("subtitle", "")),
        "descriptionEn": seed.get("descriptionEn", seed.get("description", "")),
    }
    if not in_catalog:
        entry["hidden"] = True
    catalog["worlds"] = [w for w in catalog.get("worlds", []) if w.get("id") != slug] + [entry]
    index_path.parent.mkdir(parents=True, exist_ok=True)
    index_path.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_entry_page(payload)
    missing = [job["path"] for job in build_prompts(seed, level, work) if not (world_dir / job["path"]).is_file()]
    print(f"        world.json written to {rel(world_dir)}")
    if missing:
        print(f"        note: {len(missing)} image slots are empty (connect an image API to fill them)")
    return payload


def write_entry_page(payload: dict) -> None:
    """worlds/<slug>/index.html — the bundled player, opened straight into this world."""
    page = TEMPLATE.read_text(encoding="utf-8")
    page = page.replace('href="app/style.css', 'href="../../app/style.css')
    page = page.replace('src="app/app.js', 'src="../../app/app.js')
    page = page.replace('src="app/keepsake-viewer.js', 'src="../../app/keepsake-viewer.js')
    page = page.replace('<section id="catalogView" class="catalog-view">', '<section id="catalogView" class="catalog-view" hidden>')
    page = page.replace('<div class="creator-entry">', '<div class="creator-entry" hidden>')
    safe_title = escape(str(payload.get("title") or payload["id"]), quote=True)
    safe_id = json.dumps(payload["id"], ensure_ascii=False).replace("</", "<\\/")
    page = page.replace("<title>异境拾光 · Glimmers of Elsewhere</title>", f"<title>{safe_title} · Glimmers of Elsewhere</title>")
    page = page.replace('<script src="../../app/app.js', f'<script>window.__WORLD_ID__={safe_id};</script><script src="../../app/app.js')
    out = W / payload["id"] / "index.html"
    out.write_text(page, encoding="utf-8")
    print(f"        entry page   -> worlds/{payload['id']}/index.html")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sentence", required=True)
    parser.add_argument("--slug")
    parser.add_argument("--scenes", type=int, default=8)
    parser.add_argument("--endings", type=int, default=3)
    parser.add_argument("--style", default=DEFAULT_STYLE)
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--from-stage", choices=STAGES, default="seed",
                        help="start here; earlier stages are loaded from cache (missing cache => error)")
    parser.add_argument("--plan-only", action="store_true", help="stages 1-4 only, no image generation")
    parser.add_argument("--in-catalog", action="store_true", help="list this world in the local catalogue instead of hiding it")
    args = parser.parse_args()
    start = STAGES.index(args.from_stage)

    def skipped(stage: str) -> bool:
        return STAGES.index(stage) < start

    sentence = args.sentence.strip()
    work_guess = args.slug or re.sub(r"[^a-z0-9-]+", "-", sentence.lower())[:32].strip("-")
    if not work_guess:
        # 中文等非 ASCII 句子推不出 slug：给每句话一个稳定且唯一的目录名。
        work_guess = "oneshot-" + hashlib.sha1(sentence.encode("utf-8")).hexdigest()[:8]
    work = WORK / work_guess
    # 重跑同一句话必须回到同一个工作目录（缓存 + 同一个 slug）：每个目录记住自己那句话。
    if not args.slug and not (work / "world_seed.json").is_file():
        for marker in sorted(WORK.glob("*/input.txt")) if WORK.is_dir() else []:
            if marker.read_text(encoding="utf-8").strip() == sentence:
                work = marker.parent
                break
    work.mkdir(parents=True, exist_ok=True)
    (work / "input.txt").write_text(sentence + "\n", encoding="utf-8")
    print(f"== one-shot world ==")
    print(f"   sentence: {sentence}")
    print(f"   work dir: {rel(work)}")

    if skipped("seed"):
        seed_path = work / "world_seed.json"
        if not seed_path.is_file():
            raise SystemExit(f"--from-stage {args.from_stage}: 缓存里没有 {rel(seed_path)}")
        seed = json.loads(seed_path.read_text(encoding="utf-8"))
        print("[1/6] seed: loaded from cache (skipped)")
    else:
        seed = stage_seed(sentence, work, None if args.style == DEFAULT_STYLE else args.style)
    # 尽量让工作目录名等于设定卡里的真实 slug。
    if seed.get("slug") and work.name != seed["slug"]:
        target = WORK / seed["slug"]
        if target.is_dir() and (target / "world_seed.json").is_file():
            work = target
        elif not target.exists():
            work.rename(target)
            work = target
    seed["scene_count"] = int(seed.get("scene_count") or args.scenes)
    seed["ending_count"] = int(seed.get("ending_count") or args.endings)
    if args.slug:
        seed["slug"] = args.slug
    if not args.plan_only and not skipped("character"):
        stage_character(seed, work)
    if skipped("level"):
        level_path = work / "level.json"
        if not level_path.is_file():
            raise SystemExit(f"--from-stage {args.from_stage}: 缓存里没有 {rel(level_path)}")
        level = json.loads(level_path.read_text(encoding="utf-8"))
        print("[3/6] level: loaded from cache (skipped)")
    else:
        level = stage_level(seed, work)
    jobs = build_prompts(seed, level, work)
    if args.plan_only:
        print("[5/6] images: skipped (plan-only)")
        print("[6/6] assemble: skipped (plan-only)")
        print(f"\nRESULT {json.dumps({'ok': True, 'planOnly': True, 'worldId': None, 'title': seed['title'], 'playUrl': None, 'workDir': rel(work), 'calls': CALLS}, ensure_ascii=False)}")
        return 0
    if skipped("images"):
        print("[5/6] images: loaded from cache (skipped)")
    else:
        stage_images(seed, jobs, work, args.workers)
    payload = stage_assemble(seed, level, work, [], in_catalog=args.in_catalog)
    play = f"{PLAY_BASE}/worlds/{payload['id']}/?lang=zh"
    print(f"\nRESULT {json.dumps({'ok': True, 'worldId': payload['id'], 'title': payload['title'], 'playUrl': play, 'workDir': rel(work), 'calls': CALLS}, ensure_ascii=False)}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001
        if os.environ.get("GLIMMERS_DEBUG"):
            raise
        # 不打印带绝对路径的 traceback（会暴露本机用户名）；只留一行干净的错误。
        print(f"\nRESULT {json.dumps({'ok': False, 'error': str(error)[:300], 'calls': CALLS}, ensure_ascii=False)}")
        raise SystemExit(1)
