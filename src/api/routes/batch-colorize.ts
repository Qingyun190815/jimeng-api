import path from "path";
import { promises as fs } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import _ from "lodash";

import Request from "@/lib/request/Request.ts";
import Response from "@/lib/response/Response.ts";
import {
  cancelBatchColorizeJob,
  createBatchColorizeJob,
  getBatchColorizeJob,
} from "@/lib/batch-colorize.ts";

const pagePath = path.join(process.cwd(), "public", "batch-colorize.html");
const execFileAsync = promisify(execFile);

export default {
  get: {
    "/batch-colorize": async () => {
      const html = await fs.readFile(pagePath, "utf8");
      return new Response(html, { type: "html" });
    },

    "/v1/batch-colorize/jobs/:jobId": async (request: Request) => {
      const job = getBatchColorizeJob(request.params.jobId);
      if (!job) {
        throw new Error("Batch job not found");
      }
      return job;
    },
  },

  post: {
    "/v1/batch-colorize/jobs": async (request: Request) => {
      request
        .validate("body.inputDir", _.isString)
        .validate("body.token", _.isString);

      return await createBatchColorizeJob({
        inputDir: request.body.inputDir,
        outputDir: request.body.outputDir,
        token: request.body.token,
        model: request.body.model,
        prompt: request.body.prompt,
        ratio: request.body.ratio,
        resolution: request.body.resolution,
        sampleStrength: request.body.sampleStrength,
        negativePrompt: request.body.negativePrompt,
        intelligentRatio: request.body.intelligentRatio,
        recursive: request.body.recursive,
        overwrite: request.body.overwrite,
        continueOnError: request.body.continueOnError,
        delayMs: request.body.delayMs,
      });
    },

    "/v1/batch-colorize/jobs/:jobId/cancel": async (request: Request) => {
      const job = cancelBatchColorizeJob(request.params.jobId);
      if (!job) {
        throw new Error("Batch job not found");
      }
      return job;
    },

    "/v1/batch-colorize/select-directory": async (request: Request) => {
      const title = request.body?.title || "选择文件夹";
      const directory = await selectDirectory(title);
      return { directory };
    },
  },
};

async function selectDirectory(title: string) {
  if (process.platform !== "win32") {
    throw new Error("目录选择弹窗当前仅支持 Windows。请手动输入目录路径。");
  }

  const safeTitle = String(title).replace(/'/g, "''");
  const script = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '${safeTitle}'
$dialog.ShowNewFolderButton = $true
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.SelectedPath
  exit 0
}
exit 2
`;

  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-STA",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ], { windowsHide: false });

    const directory = stdout.trim();
    if (!directory) {
      throw new Error("未选择目录。");
    }
    return directory;
  } catch (error) {
    if (error?.code === 2) {
      throw new Error("已取消选择目录。");
    }
    throw error;
  }
}
