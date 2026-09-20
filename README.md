# Image Atelier

一个面向画廊工作流的多模型生图应用，支持 OpenAI 与 Gemini 提供商。

## 开发

```bash
npm install
npm run dev
```

生产构建：

```bash
npm run build
npm run preview
```

桌面版开发预览（先构建前端，再启动 Electron）：

```bash
npm run desktop
```

## 发布

- 在 GitHub Actions 中手动运行 `Release Windows`，输入语义化版本号（如 `1.2.3`），工作流会创建 `v1.2.3` Release 并上传可直接双击运行的 Windows x64 portable EXE。
- `Publish Docker Image` 会在推送到 `main`、推送 `v*` 标签或手动运行时，将镜像发布到 `ghcr.io/yansd001/imageatelier`。手动运行时可输入镜像版本号。

本地运行容器：

```bash
docker run --rm -p 8080:80 ghcr.io/yansd001/imageatelier:latest
```

## 使用

打开页面后，在右上角设置中填写全局 `Base URL` 和 `API Key`。Base URL 只需要填写域名，例如 `https://code.yansd666.com`，程序会自动为 OpenAI 追加 `/v1`、为 Gemini 追加 `/v1beta`。OpenAI、Gemini 也可以单独填写配置进行覆盖。左侧选择提供商与模型，模型既可以从下拉建议中选择，也可以直接输入自定义模型 ID。

也可以通过可选的 URL 查询参数直接设置全局配置：

```text
https://example.com/?baseurl=https%3A%2F%2Fcode.yansd666.com&apikey=YOUR_API_KEY
```

`baseurl` 和 `apikey` 可以单独使用。参数存在时会覆盖浏览器中已保存的对应全局配置，并继续保存到本地；不传参数时仍使用原有配置。参数值应进行 URL 编码，且 API Key 会出现在浏览器地址、历史记录和可能的服务器日志中，仅应在可信环境下使用。

- OpenAI 显示尺寸、质量、背景、输出格式、生成数量，调用 `/images/generations`；多张图片按数量逐张请求，每张失败自动重试一次。
- Gemini 显示画面比例、图像分辨率、生成数量，调用 `models/{model}:generateContent`，解析 `inlineData` 图片响应；多张图片同样逐张请求，失败图片会跳过并保留成功结果。

生成面板支持上传最多 8 张 JPG、PNG 或 WEBP 参考图。OpenAI 会自动切换到 `/images/edits` multipart 请求，Gemini 会将参考图作为 `inlineData` 发送。任务信息、工作区和配置保存在浏览器 `localStorage` 中，原图和参考图保存在 IndexedDB 中，旧版本数据会自动迁移。

画廊支持提示词搜索、收藏筛选、图片灯箱预览、上一张/下一张、下载、复制提示词和删除任务。点击画廊记录上的编辑按钮，可以恢复该任务的提示词、提供商、模型、参数、工作区和参考图并重新生成；重新生成会创建新记录，不会覆盖原作品。

- 左侧目录可在「日期」和「工作区」两个 Tab 之间切换，各自记住筛选条件，仅应用当前 Tab 的目录筛选。日期按当前电脑的本地日期分组，也可以选择「全部作品」。页面只读取当前结果的图片，每次展示 48 个作品，可继续加载更多。
- 可在目录或生成面板新建工作区。生成面板自动记住上次选择，包括「不选择工作区」。画廊作品下方的工作区标签可用于归类、移动或取消归类，也可以批量设置工作区。
- 开启「批量选择」后，按作品勾选或全选当前筛选结果。打包下载包含选中作品的全部原图，使用实际图片格式；删除会先显示作品数和图片数，确认后执行。
- 「导出备份」导出当前浏览器的全部作品、原图、参考图、提示词、生成参数、收藏和工作区为 ZIP 文件（不受当前筛选影响）。在另一台电脑选择「导入备份」即可恢复。导入与现有画廊合并，相同 ID 的作品跳过，同名工作区合并，不覆盖已有作品。备份不包含 API Key 或 API 配置；另一台电脑需单独配置。生成中的任务导入后可重试。单个备份支持最多 1 GB。
- 模型输入框在点击展开或重新获得焦点时显示全部已拉取模型，仅在输入时筛选，仍可直接输入自定义模型 ID。

## 验证

```bash
npm test
npx playwright install chromium
npm run test:ui
npm run build
```

自动化测试覆盖目录筛选、工作区归类与选择记忆、模型下拉、批量删除和 ZIP 下载、备份迁移与校验，以及移动端布局。生图接口使用模拟响应，不消耗真实 API 配额。

网站 logo 文件放在 `public/logo.png`。建议使用烟神殿原图，页面会以方形裁剪方式显示在左上角和浏览器标签页。
