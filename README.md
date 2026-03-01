# EasyIngest

本地网页工具：扫描视频文件 -> AI 建议命名/分类 -> 人工编辑确认 -> 执行重命名和移动。

## 运行

```bash
npm install
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)

## 配置（可选）

不配置 AI 时会使用本地规则识别文件名。

1. 复制模板文件：

```bash
cp .env.example .env
```

2. 编辑 `.env`：

```bash
AI_API_KEY=your_key
AI_API_BASE=https://api.openai.com/v1
AI_MODEL=gpt-4.1-mini
TITLE_LANGUAGE=zh
INPUT_DIR=/path/to/input
OUTPUT_DIR=/path/to/output
PORT=3000
```

也可以继续用命令行 `export` 环境变量覆盖 `.env` 中的值。
其中 `INPUT_DIR` 和 `OUTPUT_DIR` 配置后，页面会自动回填，扫描时可不手动输入。
`TITLE_LANGUAGE` 用于统一片名语言：`zh`（中文）或 `en`（英文）。

## 规则

- 电影（单文件）：`片名 (年份).ext`
- 剧集（多文件）：`剧名/SXX/剧名 - SXXEXX.ext`（剧集目录不带年份）
- 分类策略：类型（movie/tv/anime/show）统一以 AI 结果为准（AI 不可用时回退本地）
- 命名策略：本地若已识别出“中文片名 + 年份”，优先沿用本地片名和年份；否则使用 AI 结果
- 年份补全：当本地已提取到片名但缺少年份时，会用该片名向 AI 追加查询年份并回填
- AI 调用优化：同一剧集分组只调用一次接口，结果批量应用到各集
- 多集剧集识别时优先使用所在文件夹名称（会自动跳过 `S01/Season 1` 这类季目录）
- 执行移动后会自动删除输入目录下已变空的子文件夹（不会删除输入根目录）
- 字幕会跟随视频一起移动并改名（支持 `srt/ass/ssa/sub/vtt`）
- 当输入目录下已不存在任何视频文件时，会自动清理剩余非视频文件（如图片、种子）并删除空子目录
- 类型目录映射：
  - `movie -> 电影`
  - `tv -> 电视剧`
  - `anime -> 动画`
  - `show -> 节目`

## 无数据库

任务与结果保存在本地文件：

- `tasks/<taskId>.json`
- `tasks/<taskId>.result.json`
- `logs/app.log`
