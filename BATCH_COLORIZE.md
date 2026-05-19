# 批量图生图上色

本项目新增了一个批量客户端脚本，用于读取文件夹中的图片，并按顺序调用本地 `jimeng-api` 的图生图接口完成上色。

## 启动 API 服务

先确保 `jimeng-api` 服务正在运行：

```bash
npm install
npm run build
npm run start
```

默认接口地址为 `http://localhost:5100`。

## 批量处理

### 使用 UI

启动服务后，在浏览器打开：

```text
http://localhost:5100/batch-colorize
```

在页面中填写输入文件夹、输出文件夹、Session ID、提示词和模型参数，点击“开始上色”。任务会在页面右侧显示进度、队列状态和日志。

支持两种目录方式：

- 点击“选择”按钮选择输入/输出目录：浏览器会直接读取输入目录图片，并把结果写入选择的输出目录。
- 手动输入本机路径：由服务端按路径读取和保存，适合作为目录选择不可用时的兜底。

浏览器目录选择需要 Chromium 系浏览器支持 File System Access API；`localhost` 页面可直接使用。

### 使用命令行

```bash
npm run batch:colorize -- --input ./input-images --output ./colored-images --token YOUR_SESSION_ID
```

也可以使用环境变量保存 sessionid：

```bash
$env:JIMENG_SESSION_ID="YOUR_SESSION_ID"
npm run batch:colorize -- --input ./input-images --output ./colored-images
```

国际站 token 按原项目规则添加地区前缀，例如 `us-YOUR_SESSION_ID`、`hk-YOUR_SESSION_ID`、`jp-YOUR_SESSION_ID`、`sg-YOUR_SESSION_ID`。

## 常用参数

- `--input <dir>`：输入图片文件夹，必填。
- `--output <dir>`：输出文件夹，默认是 `<input>/colorized`。
- `--token <sessionid>`：即梦 sessionid，也可用 `JIMENG_SESSION_ID`。
- `--api <url>`：API 地址，默认 `http://localhost:5100`。
- `--prompt <text>`：上色提示词。
- `--model <name>`：模型，默认 `jimeng-4.5`。
- `--ratio <ratio>`：输出比例，默认 `1:1`。
- `--resolution <level>`：分辨率，默认 `2k`。
- `--sample-strength <number>`：图生图强度，默认 `0.5`。
- `--negative-prompt <text>`：负面提示词。
- `--intelligent-ratio`：启用智能比例。
- `--recursive`：递归读取子目录。
- `--overwrite`：覆盖已存在输出文件。
- `--delay <ms>`：每张图片之间等待的毫秒数。
- `--continue-on-error <bool>`：单张失败后是否继续，默认 `true`。

## 示例

递归处理线稿目录，并降低请求频率：

```bash
npm run batch:colorize -- --input ./linearts --output ./colored --recursive --delay 3000 --token us-YOUR_SESSION_ID
```

指定更明确的上色提示词：

```bash
npm run batch:colorize -- --input ./input --output ./output --token YOUR_SESSION_ID --prompt "为黑白漫画线稿上色，保持线条清晰，色彩自然，人物肤色和服装层次丰富"
```

脚本会把生成结果保存为 `原文件名_colorized.webp`，并在输出目录写入 `batch-colorize-report.json`。
