# Image Atelier 的 OpenAI `gpt-image-2` 生图接口

> 文档日期：2026-08-05  
> 适用范围：当前仓库中的 OpenAI Image API 调用  
> 核心实现：[`src/lib/imageApi.ts`](../src/lib/imageApi.ts)

## 1. 接口概览

项目没有使用 OpenAI SDK，而是由浏览器通过 `fetch` 直接调用兼容 OpenAI Image API 的服务。

| 场景 | HTTP 方法 | 路径 | 请求格式 |
| --- | --- | --- | --- |
| 文本生成图片 | `POST` | `/v1/images/generations` | `application/json` |
| 参考图生成或编辑 | `POST` | `/v1/images/edits` | `multipart/form-data` |
| 拉取可用模型 | `GET` | `/v1/models` | 无请求体 |

项目内部统一入口为：

```ts
generateImages(
  provider: Provider,
  settings: Settings,
  model: string,
  prompt: string,
  params: GenerationParams,
  referenceImages?: ReferenceImage[],
): Promise<string[]>
```

OpenAI 分支的路由规则：

```text
referenceImages.length === 0
    -> POST /v1/images/generations

referenceImages.length > 0
    -> POST /v1/images/edits
```

`gpt-image-2` 的模型别名为 `gpt-image-2`，当前官方默认快照为 `gpt-image-2-2026-04-21`。项目允许手动输入任意模型 ID，没有把模型固定为某个版本。

## 2. 鉴权与 Base URL

### 2.1 鉴权

所有 OpenAI 请求都使用 Bearer Token：

```http
Authorization: Bearer <API_KEY>
```

配置优先级如下：

```text
OpenAI 专用 API Key > 全局 API Key
OpenAI 专用 Base URL > 全局 Base URL > 项目默认 Base URL
```

当前默认 Base URL 是：

```text
https://code.yansd666.com
```

设置中可以填写：

```text
https://api.openai.com
https://api.openai.com/v1
https://your-openai-compatible-gateway.example.com
```

代码会移除末尾的 `/v1` 或 `/v1beta`，再为 OpenAI 统一追加 `/v1`，避免形成 `/v1/v1/...`。

### 2.2 安全边界

当前应用会在浏览器侧持有 API Key，并直接发送请求。公开部署时不应把高权限 OpenAI Key 下发给不可信客户端；更稳妥的部署方式是让前端调用受控的后端代理，由代理完成鉴权、额度限制、审计和密钥保管。

## 3. 文本生成图片

### 3.1 请求

```http
POST <BASE_URL>/v1/images/generations
Content-Type: application/json
Authorization: Bearer <API_KEY>
```

项目实际发送的 JSON：

当界面选择生成多张图片时，客户端会按数量串行发起多次请求。每次请求固定只生成一张（`n: 1`），单次失败会自动重试一次；两次都失败的图片会跳过，其他成功结果仍会保存到同一个画廊任务中。

```json
{
  "model": "gpt-image-2",
  "prompt": "一只坐在窗边阅读的橘猫，柔和自然光，写实摄影",
  "size": "1024x1024",
  "quality": "high",
  "background": "auto",
  "output_format": "png",
  "n": 1
}
```

对应实现：

```ts
const body = {
  model,
  prompt,
  size: params.size,
  quality: params.quality,
  background: params.background,
  output_format: params.outputFormat,
  n: 1,
}
```

### 3.2 cURL 示例

```bash
curl -X POST "https://api.openai.com/v1/images/generations" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-2",
    "prompt": "一只坐在窗边阅读的橘猫，柔和自然光，写实摄影",
    "size": "1024x1024",
    "quality": "high",
    "background": "auto",
    "output_format": "png",
    "n": 1
  }'
```

## 4. 参考图生成或编辑

只要上传了至少一张参考图，项目就会切换到图片编辑接口。

### 4.1 请求

```http
POST <BASE_URL>/v1/images/edits
Authorization: Bearer <API_KEY>
Content-Type: multipart/form-data; boundary=<浏览器自动生成>
```

FormData 字段：

| 字段 | 值 | 项目行为 |
| --- | --- | --- |
| `model` | `gpt-image-2` | 必传 |
| `prompt` | 文本提示词 | 必传 |
| `size` | 尺寸或 `auto` | 总是发送 |
| `quality` | `auto` / `low` / `medium` / `high` | 总是发送 |
| `background` | `auto` / `opaque` / `transparent` | 总是发送 |
| `output_format` | `png` / `jpeg` / `webp` | 总是发送 |
| `n` | `1` 到 `4` | 总是发送 |
| `image[]` | 图片二进制 | 每张参考图追加一次 |

浏览器会自动生成 multipart boundary，因此代码没有手动设置 `Content-Type`，这是正确的 FormData 用法。

### 4.2 cURL 示例

```bash
curl -X POST "https://api.openai.com/v1/images/edits" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -F "model=gpt-image-2" \
  -F "image[]=@reference-1.png" \
  -F "image[]=@reference-2.jpg" \
  -F "prompt=保留主体身份和服装，将场景改成雨夜的霓虹街道" \
  -F "size=1536x1024" \
  -F "quality=high" \
  -F "background=auto" \
  -F "output_format=png" \
  -F "n=1"
```

### 4.3 项目侧参考图规则

- 前端最多接收 8 张参考图；OpenAI 官方接口当前最多允许 16 张，因此项目限制更严格。
- 文件选择器实际使用 `accept="image/*"`，代码没有严格限制为 README 所写的 JPG、PNG、WEBP。
- 代码没有检查单文件大小、图片尺寸或总请求体大小，超限错误会由网关或 OpenAI API 返回。
- 图片先被读取为 Base64 Data URL，发送时再转换回 `Blob` 并追加为 `image[]`。
- 项目未实现 `mask` 局部重绘。
- 项目未发送 `input_fidelity`。这符合 `gpt-image-2` 的要求，因为该模型会自动以高保真方式处理所有输入图片，不允许调整此参数。

## 5. 当前支持的参数

参数类型定义位于 [`src/types.ts`](../src/types.ts)，界面定义位于 [`src/App.tsx`](../src/App.tsx)。

| 项目字段 | API 字段 | 默认值 | 项目可选值或范围 | `gpt-image-2` 说明 |
| --- | --- | --- | --- | --- |
| `model` | `model` | 空 | 任意字符串 | 建议使用 `gpt-image-2`；也可固定快照 `gpt-image-2-2026-04-21` |
| `prompt` | `prompt` | 空 | 非空字符串 | 官方最大 32,000 字符；项目未做长度校验 |
| `size` | `size` | `auto` | 见下表 | 支持满足约束的任意分辨率 |
| `quality` | `quality` | `auto` | `auto`、`low`、`medium`、`high` | `low` 适合草稿，`high` 适合最终成品 |
| `background` | `background` | `auto` | `auto`、`transparent`、`opaque` | `gpt-image-2` 不支持 `transparent` |
| `outputFormat` | `output_format` | `png` | `png`、`jpeg`、`webp` | JPEG 通常比 PNG 更快 |
| `count` | 多次请求的次数 | `1` | `1` 到 `4` | 客户端逐张请求，每次向 API 发送 `n: 1`；单次失败自动重试一次 |

### 5.1 界面提供的尺寸

```text
1024x1024
1536x1024
1024x1536
2048x2048
2048x1152
1152x2048
3840x2160
2160x3840
auto
```

`gpt-image-2` 的自定义尺寸约束：

- 长边不超过 `3840px`。
- 宽和高都必须是 `16px` 的整数倍。
- 长边与短边比例不超过 `3:1`。
- 总像素数在 `655,360` 到 `8,294,400` 之间。
- 超过 `2560x1440`，即 `3,686,400` 总像素的输出属于实验性能力。
- 方形图片通常生成更快。

项目当前列出的所有尺寸都满足基本尺寸约束。其中 `2048x2048`、`3840x2160` 和 `2160x3840` 属于官方所说的实验性高分辨率范围。

### 5.2 项目尚未暴露的官方参数

| API 参数 | 用途 | 当前状态 |
| --- | --- | --- |
| `moderation` | `auto` 或较宽松的 `low` | 未实现 |
| `output_compression` | JPEG/WEBP 压缩级别 `0` 到 `100` | 未实现，接口默认值为 `100` |
| `stream` | 流式返回图片 | 未实现 |
| `partial_images` | 流式返回 `0` 到 `3` 张中间图 | 未实现 |
| `user` | 传递终端用户标识，辅助风控 | 未实现 |
| `mask` | 指定局部编辑区域 | 未实现 |

## 6. 响应格式与项目解析

GPT Image 模型默认返回 Base64 图片：

```json
{
  "created": 1785888000,
  "data": [
    {
      "b64_json": "iVBORw0KGgoAAA..."
    }
  ],
  "output_format": "png",
  "quality": "high",
  "size": "1024x1024"
}
```

项目只读取：

```ts
data[].b64_json
data[].url
```

解析规则：

1. 有 `b64_json` 时，将其包装成 Data URL 后返回。
2. 没有 `b64_json` 但有 `url` 时，再通过 `fetch` 下载远程图片并转成 Data URL。
3. 两者都没有时忽略该条目。
4. 最终没有任何有效图片时抛出 `OpenAI 未返回图片数据`。

官方 GPT Image 响应固定使用 `b64_json`；`url` 分支主要用于兼容其他模型或第三方兼容网关。

### 6.1 当前输出格式问题

项目把所有 Base64 响应都包装为：

```text
data:image/png;base64,...
```

即使请求的 `output_format` 是 `jpeg` 或 `webp`，Data URL 的 MIME 类型仍会被标成 `image/png`。下载文件名也固定使用 `.png`。因此当前最稳妥的配置是继续使用 PNG；如需可靠使用 JPEG/WEBP，应让解析逻辑根据 `output_format` 设置 MIME 类型和下载扩展名。

## 7. 模型发现接口

点击“拉取模型”时，项目请求：

```http
GET <BASE_URL>/v1/models
Authorization: Bearer <API_KEY>
```

期望响应：

```json
{
  "data": [
    { "id": "gpt-image-2" }
  ]
}
```

OpenAI 模型过滤条件为：模型 ID 同时包含 `gpt` 和 `image`，不区分大小写。因此 `gpt-image-2` 和 `gpt-image-2-2026-04-21` 都能被识别。即使拉取不到模型，用户仍可在输入框中手动填写模型 ID。

## 8. 错误处理

| 情况 | 当前行为 |
| --- | --- |
| API Key 为空 | 请求前抛出中文配置提示 |
| 模型 ID 为空 | 请求前抛出 `请输入生图模型` |
| HTTP 非 2xx 且响应含 `error.message` | 展示 API 返回的消息 |
| HTTP 非 2xx 但没有 `error.message` | 展示 `OpenAI 请求失败 (<status>)` |
| 响应没有图片 | 展示 `OpenAI 未返回图片数据` |
| URL 图片下载失败或被 CORS 拦截 | 展示远程图片缓存失败提示 |
| 服务返回非 JSON 错误页 | `response.json()` 会直接失败，无法进入项目的状态码兜底文案 |

调用方会先创建一条 `running` 状态的画廊任务；成功后写入图片并改成 `done`，失败后改成 `error` 并保存错误文本。重试会复用原任务的模型、提示词、参数和参考图。

## 9. 接入检查清单

- Base URL 填域名或网关根路径，末尾带不带 `/v1` 都可以。
- API Key 需要有目标服务的图片生成权限。
- 模型填写 `gpt-image-2`，需要稳定行为时填写快照 `gpt-image-2-2026-04-21`。
- 使用 `gpt-image-2` 时不要选择透明背景，应使用 `auto` 或 `opaque`。
- 使用参考图会调用 `/images/edits`，网关必须支持 multipart 和重复的 `image[]` 字段。
- 网关需要允许应用来源的 CORS 请求。
- 非流式接口可能耗时较长，官方提示复杂请求可能处理到约 2 分钟；代理超时应相应放宽。
- 当前 JPEG/WEBP 的 MIME 和下载扩展名处理不完整，生产使用前应修正或统一选择 PNG。
- 公网应用应通过后端代理保护 OpenAI API Key，不要向终端用户分发高权限密钥。

## 10. 官方资料

- [GPT Image 2 模型说明](https://developers.openai.com/api/docs/models/gpt-image-2)
- [Image generation 指南](https://developers.openai.com/api/docs/guides/image-generation)
- [Create image API 参考](https://developers.openai.com/api/reference/resources/images/methods/generate)
- [Create image edit API 参考](https://developers.openai.com/api/reference/resources/images/methods/edit)

官方文档会持续更新。接口参数、模型快照、限额和价格应以上述官方页面为准；本文件中的“项目行为”以当前仓库代码为准。
