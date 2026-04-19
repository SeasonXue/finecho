# 定时抓取（GitHub Actions）

每个工作日北京时间 12:00，GitHub Actions 自动跑 `bun run fetch`，把新增字幕 commit & push 回 `main`。

Workflow 文件：`.github/workflows/fetch.yml`

---

## 一次性配置

1. **推送 workflow**：

   ```bash
   git add .github/workflows/fetch.yml
   git commit -m "ci: schedule weekday fetch"
   git push
   ```

2. **首次手动触发**（不要等到下个工作日）：
   - 打开仓库 → **Actions** tab
   - 左侧选 **"fetch youtube transcripts"**
   - 右上角 **Run workflow** → 选 `main` → **Run**
   - 等几分钟，看本次 run 是否绿灯
   - 绿灯 = 通过；红灯 = 进 [故障排查](#故障排查)

3. **确认仓库设置允许 Actions push**：
   - **Settings → Actions → General → Workflow permissions**
   - 选 **Read and write permissions**（默认是只读，必须改）
   - 保存

---

## 日常操作

### 看运行状态

- **Actions** tab 列出所有历史 run，绿勾 = 成功，红叉 = 失败
- 点进单次 run 看每个 step 的日志
- 失败时 GitHub 会发邮件到你 GitHub 账号绑定的邮箱

### 手动触发一次（补抓 / 调试）

Actions tab → "fetch youtube transcripts" → Run workflow。和定时跑等效。

### 临时暂停定时任务

最简单：在 `.github/workflows/fetch.yml` 把 `schedule:` 那两行注释掉，留 `workflow_dispatch:`，commit & push。要恢复时再去掉注释。

> ⚠️ **GitHub 自动停 cron 的坑**：仓库连续 60 天没 push，GitHub 会**自动禁用** scheduled workflow。重新 push 一次或在 Actions tab 手动 enable 即可。

### 改时间

`.github/workflows/fetch.yml` 的 `cron` 字段：

- 当前 `"0 4 * * 1-5"` = UTC 04:00 周一到周五 = 北京 12:00
- 北京时间换算：减 8 小时
- 例：北京 18:00 = UTC 10:00 → `"0 10 * * 1-5"`
- 想周末也跑：`* * * * *` 第 5 段写 `*` 或 `1-7`

> GitHub cron 经常**延迟 5–15 分钟**，有时更长，对这个场景无所谓，别和挂钟死磕。

---

## 故障排查

### yt-dlp 报 "Sign in to confirm you're not a bot"

GitHub runner 是数据中心 IP，YouTube 经常拒。处理：

1. **本地导出 cookie**：
   ```bash
   yt-dlp --cookies-from-browser chrome --cookies cookies.txt \
     "https://www.youtube.com/@yutinghaofinance/streams"
   ```

2. **存到 GitHub Secrets**：
   - 仓库 **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `YT_COOKIES`
   - Value: 把 `cookies.txt` 整个内容贴进去

3. **改 workflow**，在 "Install yt-dlp" 之后、"Fetch new transcripts" 之前插入：
   ```yaml
   - name: Write cookies
     env:
       YT_COOKIES: ${{ secrets.YT_COOKIES }}
     run: echo "$YT_COOKIES" > cookies.txt
   ```

4. **改 `src/lib/yt-dlp.ts`**，让它读到 `YT_COOKIES_FILE` 时自动追加 `--cookies <path>` 参数；workflow 里 `Fetch new transcripts` step 加 `env: { YT_COOKIES_FILE: cookies.txt }`。

5. cookie 会过期（一般几个月），失效后重导一次 + 更新 secret。

### `bun install --frozen-lockfile` 失败

本地改了 `package.json` 没 commit `bun.lock`。本地跑 `bun install` 后把 `bun.lock` 一起 commit。

### git push 失败：`Permission denied` / `403`

仓库 Settings 没开 write 权限。回到 [一次性配置 第 3 步](#一次性配置)。

### push 失败：`tip of your current branch is behind`

你在本地推了新 commit，Actions 这边还是旧 SHA。重跑一次 workflow 即可（manifest 增量幂等，不会重复抓）。

### 半夜跑了一次但啥也没抓

正常。manifest 已记录所有视频，没有新增就 commit step 走 "no new transcripts" 分支，不产生 commit。

### 整个 job 超时（60 分钟）

`.github/workflows/fetch.yml` 的 `timeout-minutes` 调大，或在 fetch 命令加 `--limit N` 分多次跑。一般首次全量才会触发。

---

## 不抓什么

- `--force` 没传，所以已成功的视频和 manifest 标记为失败的视频都跳过。
- 想重试失败视频：在本地 `bun run fetch --force --limit 5` 跑完再 push（不要在 Actions 里加 `--force`，会无脑重抓全量）。

---

## 相关文件

- `.github/workflows/fetch.yml` — workflow 本体
- `src/cli/fetch.ts` — fetch 入口
- `src/lib/manifest.ts` — 增量去重逻辑
- `src/lib/yt-dlp.ts` — yt-dlp 封装（Phase 2 cookie 改这里）
