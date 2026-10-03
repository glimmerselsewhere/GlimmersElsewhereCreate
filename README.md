# GlimmersElsewhereCreate · 一句话，生成一个小游戏

把你的一句话主题，生成一个**可以在本地立刻试玩**的单关卡小世界：
设定卡 → 剧情 JSON（中英双语）→ 配图（可选）→ 打包成带入口页的可玩世界。

这个仓库是《异境拾光 / Glimmers of Elsewhere》的**设计关卡工具（独立版）**：
克隆下来就能在本地跑。**不包含任何 API Key、内部域名或私有数据**，用你自己接入的大模型服务。

## 快速开始

1. 需要 Python 3.10+（无第三方依赖；装了 `certifi` 会更严格地校验 TLS）。
2. 启动本地服务：

   ```bash
   python3 server.py
   ```

3. 打开 <http://127.0.0.1:8096/>，在「我的 API 设置」里填上你自己的接口：
   - 接口地址：`https://api.deepseek.com`（默认示例；任何 OpenAI 兼容服务都行）
   - API Key：你自己的 Key（只保存在你的浏览器里）
   - 模型：`deepseek-chat`
4. 写一句话 → 点「开始生成」。
5. 完成后点「立即试玩」：`worlds/<slug>/` 里就是完整的世界（`world.json`、中英文文案、入口页），
   可以直接玩，也可以 push 到你自己的仓库分享。

## 支持哪些接口

- 默认走 `POST {你的地址}/chat/completions`（OpenAI 兼容格式；DeepSeek / Kimi / 智谱 / OpenAI 等都可以）。
- 如果服务只提供 `POST {你的地址}/responses`（Responses 风格），会自动回退过去。
- **配图是可选的**：填了「图片接口」才会出图（`POST {图片地址}/images/generations`，`b64_json` 或 `url` 返回都支持）；
  留空则只生成剧情，游戏内图片位置显示占位。
- 「模型」可以填逗号分隔的多个模型作为失败回退链，例如 `deepseek-chat,deepseek-reasoner`。

## 目录结构

```
server.py                    本地服务：创建页 + 生成接口 + 静态世界
index.html                   创建界面（API 设置 + 一句话 + 结果）
tools/generate_world.py      生成流水线（6 个阶段，按阶段缓存，重跑只补缺失）
tools/player-template.html   播放器模板（生成世界入口页用）
app/ vendor/ i18n/           自带的播放器（进入生成的世界直接玩）
worlds/                      生成结果：worlds/<slug>/world.json + 图片 + index.html 入口页
artifacts/                   生成过程缓存（已被 .gitignore 忽略）
```

## 进阶用法

```bash
python3 tools/generate_world.py --sentence "……" --plan-only        # 只出剧情，不出图
python3 tools/generate_world.py --sentence "……" --scenes 8 --endings 3
python3 tools/generate_world.py --sentence "……" --from-stage assemble   # 从某个阶段继续
```

也可以用环境变量代替页面设置：
`GLIMMERS_LLM_BASE` / `GLIMMERS_LLM_KEY` / `GLIMMERS_LLM_MODEL` /
`GLIMMERS_IMAGE_BASE` / `GLIMMERS_IMAGE_KEY` / `GLIMMERS_IMAGE_MODEL`。

## English

GlimmersElsewhereCreate turns one sentence into a playable single-level world, locally.

- `python3 server.py` → <http://127.0.0.1:8096/> → paste your own OpenAI-compatible endpoint + key.
- Optional images: point the image fields at any `/images/generations` endpoint.
- Output: `worlds/<slug>/` — `world.json`, Chinese/English text, assets, and a playable entry page.
- This repository contains no API keys, internal endpoints, or private data.

## 声明

代码与玩法来自《异境拾光 / Glimmers of Elsewhere》。生成内容的版权归你所有（请遵守所用模型服务的条款）。
