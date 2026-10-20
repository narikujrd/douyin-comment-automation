import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function extractExtFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.(\w+)$/);
    return match ? `.${match[1]}` : ".jpg";
  } catch {
    return ".jpg";
  }
}

export async function downloadCommentImages(comments, outputPath) {
  const hasImages = comments.some((comment) => comment.imageUrls?.length > 0);
  if (!hasImages) {
    return { downloaded: 0, failed: 0 };
  }

  const imageDir = path.resolve(path.dirname(outputPath), "comment-images");
  await fs.promises.mkdir(imageDir, { recursive: true });

  let downloaded = 0;
  let failed = 0;

  for (const comment of comments) {
    if (!comment.imageUrls?.length) {
      continue;
    }
    const savedPaths = [];

    for (let index = 0; index < comment.imageUrls.length; index += 1) {
      const url = comment.imageUrls[index];
      try {
        const response = await globalThis.fetch(url);
        if (!response.ok) {
          console.warn(`[image] 下载失败 (HTTP ${response.status}): ${url.slice(0, 100)}…`);
          failed += 1;
          continue;
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        const ext = extractExtFromUrl(url);
        const hash = crypto.createHash("md5").update(url).digest("hex").slice(0, 8);
        const safeName = comment.username.replace(/[^\w\u4e00-\u9fff-]/g, "_").slice(0, 20);
        const filename = `${safeName}_${index}_${hash}${ext}`;
        const filePath = path.resolve(imageDir, filename);

        await fs.promises.writeFile(filePath, buffer);
        savedPaths.push(filePath);
        downloaded += 1;
      } catch (error) {
        console.warn(`[image] 下载异常: ${error?.message ?? error}`);
        failed += 1;
      }
    }

    delete comment.imageUrls;
    if (savedPaths.length > 0) {
      comment.imagePaths = savedPaths;
    }
  }

  if (downloaded > 0) {
    console.log(`[image] 已下载 ${downloaded} 张评论图片至 ${imageDir}`);
  }
  if (failed > 0) {
    console.warn(`[image] ${failed} 张图片下载失败`);
  }

  return { downloaded, failed };
}
