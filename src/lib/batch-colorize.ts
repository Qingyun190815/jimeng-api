import path from "path";
import { promises as fs } from "fs";

import axios from "axios";

import util from "@/lib/util.ts";
import logger from "@/lib/logger.ts";
import { generateImageComposition } from "@/api/controllers/images.ts";
import { DEFAULT_IMAGE_MODEL } from "@/api/consts/common.ts";

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

const DEFAULT_COLORIZE_PROMPT =
  "请为这张图片进行专业上色，保持原始构图、线条、人物和细节不变，补充自然协调的色彩、光影和材质，画面干净，高质量。";

export type BatchStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type BatchItemStatus = "queued" | "running" | "success" | "failed" | "skipped";

export interface BatchOptions {
  inputDir: string;
  outputDir?: string;
  token: string;
  model?: string;
  prompt?: string;
  ratio?: string;
  resolution?: string;
  sampleStrength?: number;
  negativePrompt?: string;
  intelligentRatio?: boolean;
  recursive?: boolean;
  overwrite?: boolean;
  continueOnError?: boolean;
  delayMs?: number;
}

export interface BatchItem {
  input: string;
  status: BatchItemStatus;
  urls: string[];
  outputs: string[];
  error?: string;
}

export interface BatchJob {
  id: string;
  status: BatchStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  options: Omit<BatchOptions, "token"> & { outputDir: string };
  total: number;
  current: number;
  success: number;
  failed: number;
  skipped: number;
  cancelled: boolean;
  error?: string;
  reportPath?: string;
  items: BatchItem[];
  logs: string[];
}

const jobs = new Map<string, BatchJob>();

export async function createBatchColorizeJob(options: BatchOptions): Promise<BatchJob> {
  if (!options.inputDir) {
    throw new Error("inputDir is required");
  }
  if (!options.token) {
    throw new Error("token is required");
  }

  const inputDir = path.resolve(options.inputDir);
  const outputDir = path.resolve(options.outputDir || path.join(inputDir, "colorized"));
  const recursive = Boolean(options.recursive);
  const files = await listImages(inputDir, recursive, outputDir);

  if (files.length === 0) {
    throw new Error(`No images found in ${inputDir}`);
  }

  await fs.mkdir(outputDir, { recursive: true });

  const job: BatchJob = {
    id: util.uuid(false),
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    options: {
      inputDir,
      outputDir,
      model: options.model || DEFAULT_IMAGE_MODEL,
      prompt: options.prompt || DEFAULT_COLORIZE_PROMPT,
      ratio: options.ratio || "1:1",
      resolution: options.resolution || "2k",
      sampleStrength: Number.isFinite(Number(options.sampleStrength)) ? Number(options.sampleStrength) : 0.5,
      negativePrompt: options.negativePrompt || "",
      intelligentRatio: Boolean(options.intelligentRatio),
      recursive,
      overwrite: Boolean(options.overwrite),
      continueOnError: options.continueOnError !== false,
      delayMs: Number.isFinite(Number(options.delayMs)) ? Math.max(0, Number(options.delayMs)) : 0,
    },
    total: files.length,
    current: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    cancelled: false,
    items: files.map((file) => ({
      input: file,
      status: "queued",
      urls: [],
      outputs: [],
    })),
    logs: [],
  };

  jobs.set(job.id, job);
  runBatch(job, options.token).catch((error) => {
    job.status = "failed";
    job.error = error.message;
    addLog(job, `任务失败: ${error.message}`);
    touch(job);
  });

  return sanitizeJob(job);
}

export function getBatchColorizeJob(jobId: string): BatchJob | undefined {
  const job = jobs.get(jobId);
  return job ? sanitizeJob(job) : undefined;
}

export function cancelBatchColorizeJob(jobId: string): BatchJob | undefined {
  const job = jobs.get(jobId);
  if (!job) return undefined;
  job.cancelled = true;
  if (job.status === "queued") {
    job.status = "cancelled";
  }
  addLog(job, "已请求停止，当前图片完成后将停止。");
  touch(job);
  return sanitizeJob(job);
}

async function runBatch(job: BatchJob, token: string) {
  job.status = "running";
  job.startedAt = new Date().toISOString();
  addLog(job, `发现 ${job.total} 张图片，开始批量上色。`);

  for (let index = 0; index < job.items.length; index++) {
    if (job.cancelled) {
      job.status = "cancelled";
      addLog(job, "任务已停止。");
      break;
    }

    const item = job.items[index];
    job.current = index + 1;
    item.status = "running";
    addLog(job, `[${job.current}/${job.total}] 开始处理 ${path.basename(item.input)}`);

    try {
      const outputPaths = await getPlannedOutputPaths(job, item.input, [".webp"]);
      if (!job.options.overwrite && outputPaths.length > 0 && await exists(outputPaths[0])) {
        item.status = "skipped";
        item.outputs = outputPaths;
        job.skipped += 1;
        addLog(job, `跳过已存在结果: ${outputPaths[0]}`);
        continue;
      }

      const buffer = await fs.readFile(item.input);
      const urls = await generateImageComposition(
        job.options.model || DEFAULT_IMAGE_MODEL,
        job.options.prompt || DEFAULT_COLORIZE_PROMPT,
        [buffer],
        {
          ratio: job.options.ratio,
          resolution: job.options.resolution,
          sampleStrength: job.options.sampleStrength,
          negativePrompt: job.options.negativePrompt,
          intelligentRatio: job.options.intelligentRatio,
        },
        token,
      );

      item.urls = urls;
      item.outputs = [];
      for (let resultIndex = 0; resultIndex < urls.length; resultIndex++) {
        const outputPath = await getOutputPath(job, item.input, urls[resultIndex], resultIndex);
        await downloadImage(urls[resultIndex], outputPath);
        item.outputs.push(outputPath);
      }

      item.status = "success";
      job.success += 1;
      addLog(job, `完成 ${path.basename(item.input)}，保存 ${item.outputs.length} 个结果。`);
    } catch (error) {
      item.status = "failed";
      item.error = error.message;
      job.failed += 1;
      addLog(job, `失败 ${path.basename(item.input)}: ${error.message}`);
      logger.error(error);
      if (!job.options.continueOnError) {
        job.status = "failed";
        job.error = error.message;
        break;
      }
    } finally {
      touch(job);
    }

    if (job.options.delayMs && index < job.items.length - 1) {
      await sleep(job.options.delayMs);
    }
  }

  if (job.status === "running") {
    job.status = job.failed > 0 ? "failed" : "completed";
  }

  job.finishedAt = new Date().toISOString();
  job.reportPath = await writeReport(job);
  addLog(job, `批处理结束。报告: ${job.reportPath}`);
  touch(job);
}

async function listImages(dir: string, recursive: boolean, outputDir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (isSameOrInside(fullPath, outputDir)) continue;
      if (recursive) {
        files.push(...await listImages(fullPath, true, outputDir));
      }
      continue;
    }

    if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }

  return files.sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

async function getPlannedOutputPaths(job: BatchJob, inputPath: string, extensions: string[]) {
  return Promise.all(extensions.map((extension, index) => getOutputPath(job, inputPath, extension, index)));
}

async function getOutputPath(job: BatchJob, inputPath: string, urlOrExtension: string, resultIndex: number) {
  const relativeInput = path.relative(job.options.inputDir, inputPath);
  const parsed = path.parse(relativeInput);
  const resultSuffix = resultIndex === 0 ? "" : `_${String(resultIndex + 1).padStart(2, "0")}`;
  const extension = urlOrExtension.startsWith(".") ? urlOrExtension : getExtensionFromUrl(urlOrExtension) || ".webp";
  const outputDir = path.join(job.options.outputDir, parsed.dir);

  await fs.mkdir(outputDir, { recursive: true });
  return path.join(outputDir, `${parsed.name}_colorized${resultSuffix}${extension}`);
}

async function downloadImage(url: string, outputPath: string) {
  const response = await axios.get(url, { responseType: "arraybuffer" });
  await fs.writeFile(outputPath, Buffer.from(response.data));
}

async function writeReport(job: BatchJob) {
  const reportPath = path.join(job.options.outputDir, "batch-colorize-report.json");
  await fs.writeFile(reportPath, JSON.stringify(sanitizeJob(job), null, 2), "utf8");
  return reportPath;
}

async function exists(filePath: string) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function addLog(job: BatchJob, message: string) {
  job.logs.push(`[${new Date().toLocaleString()}] ${message}`);
  if (job.logs.length > 300) {
    job.logs = job.logs.slice(-300);
  }
  touch(job);
}

function sanitizeJob(job: BatchJob): BatchJob {
  return JSON.parse(JSON.stringify(job));
}

function touch(job: BatchJob) {
  job.updatedAt = new Date().toISOString();
}

function getExtensionFromUrl(value: string) {
  try {
    const ext = path.extname(new URL(value).pathname).toLowerCase();
    return ext && ext.length <= 6 ? ext : "";
  } catch {
    return "";
  }
}

function isSameOrInside(candidate: string, parent: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
