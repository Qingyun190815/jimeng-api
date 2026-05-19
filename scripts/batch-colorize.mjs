#!/usr/bin/env node

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".bmp",
  ".gif",
  ".tif",
  ".tiff",
]);

const MIME_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

const DEFAULT_PROMPT =
  "请为这张图片进行专业上色，保持原始构图、线条、人物和细节不变，补充自然协调的色彩、光影和材质，画面干净，高质量。";

const args = parseArgs(process.argv.slice(2));

if (args.help || args.h) {
  printHelp();
  process.exit(0);
}

const inputDir = path.resolve(requiredArg(args.input ?? args.i, "input"));
const outputDir = path.resolve(args.output ?? args.o ?? path.join(inputDir, "colorized"));
const apiBase = trimTrailingSlash(args.api ?? process.env.JIMENG_API_BASE ?? "http://localhost:5100");
const token = args.token ?? process.env.JIMENG_SESSION_ID ?? process.env.JIMENG_API_TOKEN;
const model = args.model ?? "jimeng-4.5";
const prompt = args.prompt ?? DEFAULT_PROMPT;
const ratio = args.ratio ?? "1:1";
const resolution = args.resolution ?? "2k";
const sampleStrength = args["sample-strength"] ?? args.sampleStrength ?? "0.5";
const negativePrompt = args["negative-prompt"] ?? args.negativePrompt;
const intelligentRatio = parseBoolean(args["intelligent-ratio"] ?? args.intelligentRatio);
const recursive = parseBoolean(args.recursive);
const overwrite = parseBoolean(args.overwrite);
const continueOnError = parseBoolean(args["continue-on-error"] ?? args.continueOnError, true);
const delayMs = Number(args.delay ?? 0);

if (!token) {
  fail("缺少 session token。请通过 --token 传入，或设置 JIMENG_SESSION_ID 环境变量。");
}

await mkdir(outputDir, { recursive: true });

const imageFiles = await listImages(inputDir, recursive);
if (imageFiles.length === 0) {
  fail(`输入目录中没有找到图片: ${inputDir}`);
}

console.log(`输入目录: ${inputDir}`);
console.log(`输出目录: ${outputDir}`);
console.log(`接口地址: ${apiBase}/v1/images/compositions`);
console.log(`待处理图片: ${imageFiles.length} 张`);

const results = [];
for (let index = 0; index < imageFiles.length; index += 1) {
  const filePath = imageFiles[index];
  const label = `[${index + 1}/${imageFiles.length}] ${path.basename(filePath)}`;

  try {
    console.log(`${label} 开始上色...`);
    const generatedUrls = await colorizeImage(filePath);
    const savedFiles = [];

    for (let resultIndex = 0; resultIndex < generatedUrls.length; resultIndex += 1) {
      const outputPath = await buildOutputPath(filePath, generatedUrls[resultIndex], resultIndex);
      if (!overwrite && await exists(outputPath)) {
        console.log(`${label} 跳过已存在文件: ${outputPath}`);
        savedFiles.push(outputPath);
        continue;
      }

      await downloadFile(generatedUrls[resultIndex], outputPath);
      savedFiles.push(outputPath);
    }

    results.push({
      input: filePath,
      status: "success",
      urls: generatedUrls,
      outputs: savedFiles,
    });
    console.log(`${label} 完成，保存 ${savedFiles.length} 个结果。`);
  } catch (error) {
    results.push({
      input: filePath,
      status: "failed",
      error: error.message,
    });
    console.error(`${label} 失败: ${error.message}`);

    if (!continueOnError) {
      break;
    }
  }

  if (delayMs > 0 && index < imageFiles.length - 1) {
    await sleep(delayMs);
  }
}

const reportPath = path.join(outputDir, "batch-colorize-report.json");
await writeFile(reportPath, JSON.stringify({
  createdAt: new Date().toISOString(),
  inputDir,
  outputDir,
  apiBase,
  model,
  prompt,
  ratio,
  resolution,
  sampleStrength: Number(sampleStrength),
  intelligentRatio,
  total: results.length,
  success: results.filter((item) => item.status === "success").length,
  failed: results.filter((item) => item.status === "failed").length,
  results,
}, null, 2), "utf8");

console.log(`批处理结束。报告: ${reportPath}`);

async function colorizeImage(filePath) {
  const buffer = await readFile(filePath);
  const extension = path.extname(filePath).toLowerCase();
  const form = new FormData();

  form.append("prompt", prompt);
  form.append("model", model);
  form.append("ratio", ratio);
  form.append("resolution", resolution);
  form.append("sample_strength", String(sampleStrength));
  form.append("response_format", "url");
  form.append("images", new Blob([buffer], {
    type: MIME_TYPES[extension] ?? "application/octet-stream",
  }), path.basename(filePath));

  if (negativePrompt) {
    form.append("negative_prompt", negativePrompt);
  }

  if (typeof intelligentRatio === "boolean") {
    form.append("intelligent_ratio", String(intelligentRatio));
  }

  const response = await fetch(`${apiBase}/v1/images/compositions`, {
    method: "POST",
    headers: {
      Authorization: formatAuthorization(token),
    },
    body: form,
  });

  const bodyText = await response.text();
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new Error(`接口返回非 JSON 内容，HTTP ${response.status}: ${bodyText.slice(0, 300)}`);
  }

  if (!response.ok || body.code && body.code !== 0) {
    throw new Error(body.message ?? `接口请求失败，HTTP ${response.status}`);
  }

  const urls = extractUrls(body);
  if (urls.length === 0) {
    throw new Error(`接口未返回图片 URL: ${JSON.stringify(body).slice(0, 500)}`);
  }

  return urls;
}

async function listImages(dir, includeSubdirs) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (isSameOrInside(fullPath, outputDir)) {
        continue;
      }
      if (includeSubdirs) {
        files.push(...await listImages(fullPath, true));
      }
      continue;
    }

    if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }

  return files.sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

async function buildOutputPath(inputPath, url, resultIndex) {
  const relativeInput = path.relative(inputDir, inputPath);
  const parsed = path.parse(relativeInput);
  const resultSuffix = resultIndex === 0 ? "" : `_${String(resultIndex + 1).padStart(2, "0")}`;
  const remoteExt = getExtensionFromUrl(url) || ".webp";
  const targetDir = path.join(outputDir, parsed.dir);

  await mkdir(targetDir, { recursive: true });
  return path.join(targetDir, `${parsed.name}_colorized${resultSuffix}${remoteExt}`);
}

async function downloadFile(url, outputPath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`下载生成图片失败，HTTP ${response.status}: ${url}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(outputPath, bytes);
}

function extractUrls(body) {
  const data = Array.isArray(body.data) ? body.data : [];
  return data
    .map((item) => item?.url)
    .filter((url) => typeof url === "string" && url.length > 0);
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      continue;
    }

    const equalsIndex = arg.indexOf("=");
    const rawKey = equalsIndex === -1 ? arg.slice(2) : arg.slice(2, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : arg.slice(equalsIndex + 1);
    if (!rawKey) {
      continue;
    }

    if (inlineValue !== undefined) {
      parsed[rawKey] = inlineValue;
      continue;
    }

    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[rawKey] = true;
      continue;
    }

    parsed[rawKey] = next;
    i += 1;
  }

  return parsed;
}

function parseBoolean(value, defaultValue = undefined) {
  if (value === undefined) return defaultValue;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "y", "on"].includes(String(value).toLowerCase());
}

function formatAuthorization(value) {
  return value.toLowerCase().startsWith("bearer ") ? value : `Bearer ${value}`;
}

function getExtensionFromUrl(value) {
  try {
    const pathname = new URL(value).pathname;
    const ext = path.extname(pathname).toLowerCase();
    return ext && ext.length <= 6 ? ext : "";
  } catch {
    return "";
  }
}

function isSameOrInside(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function requiredArg(value, name) {
  if (!value) {
    fail(`缺少必要参数 --${name}`);
  }

  return value;
}

function fail(message) {
  console.error(message);
  console.error("使用 --help 查看示例。");
  process.exit(1);
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp() {
  console.log(`
批量图生图上色工具

用法:
  node scripts/batch-colorize.mjs --input ./input --output ./output --token YOUR_SESSION_ID

常用参数:
  --input <dir>                 输入图片文件夹，必填
  --output <dir>                输出文件夹，默认: <input>/colorized
  --token <sessionid>           即梦 sessionid，也可用环境变量 JIMENG_SESSION_ID
  --api <url>                   jimeng-api 地址，默认: http://localhost:5100
  --prompt <text>               上色提示词
  --model <name>                模型，默认: jimeng-4.5
  --ratio <ratio>               输出比例，默认: 1:1
  --resolution <level>          分辨率，默认: 2k
  --sample-strength <number>    图生图强度，默认: 0.5
  --negative-prompt <text>      负面提示词
  --intelligent-ratio           启用智能比例
  --recursive                   递归读取子目录
  --overwrite                   覆盖已存在输出文件
  --delay <ms>                  每张图片之间等待毫秒数
  --continue-on-error <bool>    单张失败后继续，默认: true

示例:
  node scripts/batch-colorize.mjs --input ./linearts --output ./colored --token us-YOUR_SESSION_ID --recursive --resolution 2k
`);
}
