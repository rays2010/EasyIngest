# EasyIngest

本地网页工具：扫描视频文件 -> AI 建议命名/分类 -> 人工编辑确认 -> 执行重命名和移动。

## 使用方式总览

- 本地开发调试：`npm run dev`（自动热重启）
- NAS 长期运行：`docker compose up -d --build`
- 日常更新（推荐）：本机执行 `./deploy-nas.sh` 自动同步并重启

## 本地开发

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
HOST_PORT=3000
PORT=3000
```

也可以继续用命令行 `export` 环境变量覆盖 `.env` 中的值。
其中 `INPUT_DIR` 和 `OUTPUT_DIR` 配置后，页面会自动回填，扫描时可不手动输入。
`TITLE_LANGUAGE` 用于统一片名语言：`zh`（中文）或 `en`（英文）。

## NAS 首次部署

1. 在 NAS（当前推荐路径 `/volume3/docker/EasyIngest`）准备目录：

```bash
mkdir -p /volume3/docker/EasyIngest/{input,output,tasks,logs}
```

2. 复制环境变量并按需修改：

```bash
cp .env.example .env
```

`.env` 中推荐保持容器内目录如下：

```bash
INPUT_DIR=/data/input
OUTPUT_DIR=/data/output
```

并设置 NAS 主机挂载目录：

```bash
INPUT_HOST_DIR=/volume3/docker/EasyIngest/input
OUTPUT_HOST_DIR=/volume3/docker/EasyIngest/output
```

如需避免端口冲突，改宿主机端口即可（容器内端口保持 3000）：

```bash
HOST_PORT=3030
PORT=3000
```

3. 启动：

```bash
docker compose up -d --build
```

4. 访问：

```bash
http://<NAS_IP>:3030
```

## 日常更新（推荐）

如果 NAS 没有安装 `git`，直接在本机项目目录执行：

```bash
./deploy-nas.sh
```

脚本默认行为：

- 远程主机：`home`
- 远程目录：`/volume3/docker/EasyIngest`
- 宿主机端口：`3030`
- 自动同步代码、修正 `.env` 必要项、重建并重启容器

可选参数：

```bash
./deploy-nas.sh <ssh_host> <remote_dir>
```

示例：

```bash
HOST_PORT=3040 ./deploy-nas.sh home /volume3/docker/EasyIngest
```

## 日常运维命令

在 NAS 上执行（`docker` 可能需要 `sudo`）：

```bash
cd /volume3/docker/EasyIngest
/usr/local/bin/docker compose ps
/usr/local/bin/docker compose logs -f easyingest
/usr/local/bin/docker compose restart easyingest
```

## 常见问题

1. 端口占用（`Bind for 0.0.0.0:3000 failed`）
把 `.env` 的 `HOST_PORT` 改成空闲端口，例如 `3030`，然后重启：

```bash
/usr/local/bin/docker compose up -d --build
```

2. Docker 权限不足（`permission denied /var/run/docker.sock`）
使用可访问 Docker 的账号，或通过 `sudo -n /usr/local/bin/docker ...` 执行。

3. 镜像拉取超时
项目已默认使用镜像源 `docker.1ms.run/library/node:20-alpine`。如网络仍异常，稍后重试构建。

4. 中文路径显示乱码
从当前版本开始，服务会自动兼容 `.env` 的 UTF-8/GB18030（GBK）编码。若仍异常，建议把 `.env` 改为 UTF-8 后重启容器。

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
