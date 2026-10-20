export async function extractCommentSnapshot(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-codex-comment-scroll="true"]') || document.body;

    const normalize = (value = "") => value.replace(/\s+/g, " ").trim();
    const metaPattern =
      /(分钟前|小时前|天前|昨天|前天|刚刚|IP属地|发布于|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}:\d{2}|赞)/;
    const replyThreadPattern = /(条回复|收起)/;
    const controlPattern = /^(回复|发送|收起)$/;
    const pureNumberPattern = /^\d+$/;
    const xBandTolerance = 12;
    const replyIndentMinDelta = 16;

    const splitLines = (value = "") =>
      value
        .split(/\n+/)
        .map((line) => normalize(line))
        .filter(Boolean);

    const normalizeNameLine = (value = "") =>
      normalize(value).replace(/\s+/g, "").replace(/作者$/, "");

    const isNoiseLine = (line) => controlPattern.test(line) || pureNumberPattern.test(line);

    const fullText = (el) => {
      let t = "";
      for (const node of el.childNodes) {
        if (node.nodeType === 3) {
          t += node.textContent || "";
        } else if (node.nodeType === 1) {
          const elem = node;
          if (elem.tagName === "IMG") {
            t += elem.getAttribute("alt") || "";
          } else {
            t += fullText(elem);
          }
        }
      }
      return t;
    };

    const extractImageUrls = (container) => {
      if (!(container instanceof HTMLElement)) return [];
      const imgs = Array.from(
        container.querySelectorAll("img.douyin-creator-interactive-image-img")
      );
      return imgs
        .map((img) => (img.getAttribute("src") || "").trim())
        .filter((src) => src.length > 0 && src.startsWith("http"));
    };

    const extractReplyThreadState = (container) => {
      if (!(container instanceof HTMLElement)) {
        return { hasReplies: false, replyCount: 0 };
      }

      const replyThreadText = Array.from(container.querySelectorAll("button, div, span"))
        .map((node) => normalize(node.textContent || ""))
        .find((text) => text === "收起" || /^(?:查看|展开)?(?:全部)?\d+条回复$/.test(text));

      if (!replyThreadText) {
        return { hasReplies: false, replyCount: 0 };
      }

      const countMatch = replyThreadText.match(/(\d+)条回复/);
      const replyCount = countMatch ? Number(countMatch[1]) : null;
      return {
        // “收起”表示回复线程已经展开；无法解析数量时也采取保守策略，避免重复回复。
        hasReplies: replyThreadText === "收起" || replyCount === null || replyCount > 0,
        replyCount
      };
    };

    const parseStructuredEntry = (rawLines, order) => {
      const lines = rawLines.filter((line) => !isNoiseLine(line));
      if (lines.length < 2) {
        return null;
      }

      let cursor = 0;
      let username = normalizeNameLine(lines[cursor]);
      cursor += 1;

      while (cursor < lines.length && lines[cursor] === "作者") {
        cursor += 1;
      }

      if (!username && cursor < lines.length) {
        username = normalizeNameLine(lines[cursor]);
        cursor += 1;
      }

      const commentSegments = [];
      while (cursor < lines.length) {
        const line = lines[cursor];
        if (line === "作者") {
          cursor += 1;
          continue;
        }

        if (replyThreadPattern.test(line)) {
          break;
        }

        if (!metaPattern.test(line)) {
          commentSegments.push(line);
        }
        cursor += 1;
      }

      const commentText = normalize(commentSegments.join(" "));
      if (!username || !commentText) {
        return null;
      }

      const consumedLineCount = cursor;
      const publishText = normalize(
        lines
          .slice(1, consumedLineCount)
          .filter((line) => line !== "作者" && metaPattern.test(line))
          .join(" ")
      );

      return {
        username,
        commentText,
        publishText,
        consumedLineCount,
        order,
        signature: [username, commentText, publishText].map(normalize).join("|")
      };
    };

    const extractStructuredEntryFromBlock = (block, order) => {
      if (!(block instanceof HTMLElement)) {
        return null;
      }

      const textRows = Array.from(new Set(splitLines(block.innerText || ""))).slice(0, 40);
      const publishText =
        textRows.find((line) => metaPattern.test(line) && !controlPattern.test(line)) || "";

      // --- Targeted path: use Douyin's class selectors + fullText() ---
      const commentContentEl = block.querySelector('div[class*="comment-content-text-"]');
      if (commentContentEl) {
        const commentText = normalize(fullText(commentContentEl));

        const usernameEl = block.querySelector('div[class*="username-"]');
        let username = "";
        if (usernameEl) {
          for (const node of usernameEl.childNodes) {
            if (node.nodeType === 3) username += node.textContent || "";
          }
          username = normalizeNameLine(username);
        }

        if (username && commentText) {
          const imageUrls = extractImageUrls(block);
          const replyThreadState = extractReplyThreadState(block);
          const entry = {
            username,
            commentText,
            publishText,
            consumedLineCount: 0,
            order,
            signature: [username, commentText, publishText].map(normalize).join("|"),
            ...replyThreadState
          };
          if (imageUrls.length > 0) entry.imageUrls = imageUrls;
          return { entry };
        }
      }

      // --- Generic fallback: text-line parsing ---
      const candidates = Array.from(block.querySelectorAll("div, span, p"))
        .filter((node) => node instanceof HTMLElement)
        .map((node) => ({
          node,
          text: normalize(node.textContent || "")
        }))
        .filter((item) => item.text)
        .slice(0, 120);
      if (candidates.length === 0) {
        /**
         * ★ 本项目补丁（C-26，2026-10-17）：纯表情 / 纯图片评论不能丢。
         *
         * 抖音把「[图片表情]」这类内容渲染成图片 + 伪元素，块内所有文本节点的
         * textContent 都是空的 —— 于是 candidates 为空、整条评论被 return null 丢掉。
         * 症状很隐蔽：页面上明明挂着这条未回复评论，工具却从来没采集到过，
         * 于是「未回复列表」里越积越多，而控制台显示本轮只有寥寥几条。
         *
         * 兜底：块里有非头像的小图 → 当成表情评论，文本记为 alt 或 "[表情]"。
         * 头像图必须排除，否则每条评论都会把「头像」当成内容。
         */
        const stickerImgs = Array.from(block.querySelectorAll("img")).filter((img) => {
          if (img.closest('[class*="avatar" i]')) return false;
          const src = (img.getAttribute("src") || "").toLowerCase();
          if (src.includes("avatar")) return false;
          const rect = img.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
        if (stickerImgs.length > 0) {
          const altTexts = stickerImgs
            .map((img) => (img.getAttribute("alt") || "").trim())
            .filter(Boolean);
          const emojiText = normalize(altTexts.length > 0 ? altTexts.join("") : "[表情]");

          let emojiUser = "";
          const userEl = block.querySelector('div[class*="username-"]');
          if (userEl) {
            for (const node of userEl.childNodes) {
              if (node.nodeType === 3) emojiUser += node.textContent || "";
            }
            emojiUser = normalizeNameLine(emojiUser);
          }
          if (!emojiUser) {
            emojiUser = normalizeNameLine(textRows[0] || "");
          }

          if (emojiUser) {
            return {
              entry: {
                username: emojiUser,
                commentText: emojiText,
                publishText,
                consumedLineCount: 0,
                order,
                signature: [emojiUser, emojiText, publishText].map(normalize).join("|"),
                ...extractReplyThreadState(block)
              }
            };
          }
        }
        return null;
      }

      const usernameText =
        textRows.find((line) => {
          if (!line || line.length > 40) {
            return false;
          }
          if (
            metaPattern.test(line) ||
            replyThreadPattern.test(line) ||
            controlPattern.test(line)
          ) {
            return false;
          }
          return true;
        }) || "";

      let commentText =
        textRows.find((line) => {
          if (!line || line === usernameText || line === publishText) {
            return false;
          }
          if (
            metaPattern.test(line) ||
            replyThreadPattern.test(line) ||
            controlPattern.test(line)
          ) {
            return false;
          }
          return true;
        }) || "";

      if (!commentText) {
        const stickerImgs = Array.from(block.querySelectorAll("img")).filter((img) => {
          if (img.closest('[class*="avatar" i]')) return false;
          const src = (img.getAttribute("src") || "").toLowerCase();
          if (src.includes("avatar")) return false;
          const rect = img.getBoundingClientRect();
          // ★ C-26 补丁：去掉「<=120px」的尺寸限制 —— 抖音的表情图常常比 120px 大，
          // 卡尺寸会让这类评论解析成空文本后被整条丢掉。头像已在上面按 class/src 排除。
          return rect.width > 0 && rect.height > 0;
        });

        if (stickerImgs.length > 0) {
          const altTexts = stickerImgs
            .map((img) => (img.getAttribute("alt") || "").trim())
            .filter(Boolean);
          commentText = altTexts.length > 0 ? altTexts.join("") : "[表情]";
        }
      }

      const username = normalizeNameLine(usernameText);
      if (!username || !commentText) {
        return null;
      }

      const imageUrls = extractImageUrls(block);
      const replyThreadState = extractReplyThreadState(block);
      const entry = {
        username,
        commentText,
        publishText,
        consumedLineCount: 0,
        order,
        signature: [username, commentText, publishText].map(normalize).join("|"),
        ...replyThreadState
      };
      if (imageUrls.length > 0) entry.imageUrls = imageUrls;
      return { entry };
    };

    for (const marked of root.querySelectorAll("[data-codex-comment-block]")) {
      marked.removeAttribute("data-codex-comment-block");
    }

    const collectBlocks = () => {
      const explicitBlocks = Array.from(root.querySelectorAll("[comment-item]"));
      if (explicitBlocks.length > 0) {
        return explicitBlocks;
      }

      const replyButtons = Array.from(root.querySelectorAll("button, div, span")).filter(
        (node) => normalize(node.textContent || "") === "回复"
      );

      const blocks = [];
      const seen = new Set();

      const findBlock = (node) => {
        let current = node.parentElement;
        while (current && current !== root) {
          if (!(current instanceof HTMLElement)) {
            return null;
          }

          const text = normalize(current.innerText || "");
          const replyButtonCount = Array.from(current.querySelectorAll("button, div, span")).filter(
            (child) => normalize(child.textContent || "") === "回复"
          ).length;
          const avatarCount = current.querySelectorAll(
            'img, [class*="avatar"], [class*="Avatar"]'
          ).length;

          if (
            avatarCount >= 1 &&
            avatarCount <= 12 &&
            replyButtonCount >= 1 &&
            replyButtonCount <= 20 &&
            text.length <= 4000
          ) {
            return current;
          }

          current = current.parentElement;
        }

        return null;
      };

      for (const replyButton of replyButtons) {
        const block = findBlock(replyButton);
        if (!block || seen.has(block)) {
          continue;
        }

        seen.add(block);
        blocks.push(block);
      }

      return blocks;
    };

    const collectViaContentSelectors = () => {
      const contentEls = Array.from(root.querySelectorAll('div[class*="comment-content-text-"]'));
      if (contentEls.length === 0) return null;

      const blocks = [];
      for (let i = 0; i < contentEls.length; i++) {
        const contentEl = contentEls[i];

        let container = contentEl.parentElement;
        for (let j = 0; j < 8 && container && container !== root; j++) {
          if (container.querySelector('div[class*="username-"]')) break;
          container = container.parentElement;
        }
        if (!container) continue;

        const usernameEl = container.querySelector('div[class*="username-"]');
        if (!usernameEl) continue;

        let username = "";
        for (const node of usernameEl.childNodes) {
          if (node.nodeType === 3) username += node.textContent || "";
        }
        username = normalizeNameLine(username);

        let commentText = normalize(fullText(contentEl));
        /**
         * ★ 本项目补丁（C-26，2026-10-17）：纯表情评论的文本是空的。
         *
         * 抖音把「[图片表情]」渲染成图片，contentEl 里没有任何文本节点，
         * fullText() 返回空 —— 下面那句 `if (!username || !commentText) continue;`
         * 会把整条评论直接丢掉。实测：页面上 12 条未回复里有 9 条是纯表情，
         * 采集结果只剩 3 条，而控制台看起来"没几条没回"。
         *
         * 兜底：内容容器里有图就当表情评论，文本记 alt（没有则记 "[表情]"）。
         * 这里不用排除头像 —— contentEl 是纯内容容器，头像不在其中。
         */
        if (username && !commentText) {
          const stickerImgs = Array.from(contentEl.querySelectorAll("img")).filter((img) => {
            const rect = img.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });
          if (stickerImgs.length > 0) {
            const altTexts = stickerImgs
              .map((img) => (img.getAttribute("alt") || "").trim())
              .filter(Boolean);
            commentText = normalize(altTexts.length > 0 ? altTexts.join("") : "[表情]");
          } else {
            /**
             * 实测（2026-10-17）：表情包既不是文本节点，也**不是 <img>** ——
             * 抖音用背景图 / canvas 渲染，容器里 textLen=0、imgs=0、alt 全空。
             * 所以「用户名拿得到、内容容器存在、但一个字符都没有」本身就是
             * 纯表情评论的确定特征，直接记成 [表情]。
             */
            commentText = "[表情]";
          }
        }

        if (!username || !commentText) continue;

        const containerRows = Array.from(new Set(splitLines(container.innerText || ""))).slice(
          0,
          40
        );
        const publishText =
          containerRows.find((line) => metaPattern.test(line) && !controlPattern.test(line)) || "";

        const rect = contentEl.getBoundingClientRect();
        const signature = [username, commentText, publishText].map(normalize).join("|");

        if (container instanceof HTMLElement) {
          container.setAttribute("data-codex-comment-block", String(i));
        }

        const imageUrls = extractImageUrls(container);
        const replyThreadState = extractReplyThreadState(container);
        const entry = {
          username,
          commentText,
          publishText,
          consumedLineCount: 0,
          order: i,
          signature,
          ...replyThreadState
        };
        if (imageUrls.length > 0) entry.imageUrls = imageUrls;

        blocks.push({
          domIndex: i,
          left: Number.isFinite(rect?.left) ? rect.left : 0,
          top: Number.isFinite(rect?.top) ? rect.top : i,
          entry
        });
      }

      return blocks.length > 0 ? blocks : null;
    };

    const collectViaBlocks = () =>
      collectBlocks()
        .map((block, domIndex) => {
          if (block instanceof HTMLElement) {
            block.setAttribute("data-codex-comment-block", String(domIndex));
          }

          const rawLines = splitLines(block.innerText || "");

          if (rawLines.length === 0) {
            return null;
          }

          const rect = block instanceof HTMLElement ? block.getBoundingClientRect() : null;
          const structuredBlock = extractStructuredEntryFromBlock(block, domIndex);
          if (structuredBlock) {
            return {
              domIndex,
              left: Number.isFinite(rect?.left) ? rect.left : 0,
              top: Number.isFinite(rect?.top) ? rect.top : domIndex,
              entry: structuredBlock.entry
            };
          }

          const mainEntry = parseStructuredEntry(rawLines, domIndex);
          if (!mainEntry) {
            return null;
          }

          return {
            domIndex,
            left: Number.isFinite(rect?.left) ? rect.left : 0,
            top: Number.isFinite(rect?.top) ? rect.top : domIndex,
            entry: mainEntry
          };
        })
        .filter(Boolean);

    /**
     * ★ 本项目补丁（C-26，2026-10-17）：纯表情 / 纯图片评论会整条丢失。
     *
     * collectViaContentSelectors() 只遍历 `div[class*="comment-content-text-"]`。
     * 纯表情评论里没有文字，抖音就不会渲染这个容器 —— 于是这些评论被整批漏掉。
     * 更隐蔽的是：只要它返回非 null，就永远不会 fallback 到 collectViaBlocks()，
     * 所以症状是「页面上挂着 5 条未回复，工具只看到 2 条，而漏掉的全是表情评论」。
     *
     * 修法：拿 [comment-item] 的实际数量对账，数量不足就改用遍历所有块的路径。
     * 只在「确实少拿了」时才切换，避免影响正常评论区（正常时两条路径结果一致）。
     */
    const viaContent = collectViaContentSelectors();
    const expectedBlockCount = root.querySelectorAll("[comment-item]").length;
    const rawBlocks =
      viaContent && (expectedBlockCount === 0 || viaContent.length >= expectedBlockCount)
        ? viaContent
        : (collectViaBlocks() ?? viaContent);

    const resolveReplyIndentThreshold = (blocks) => {
      const leftPositions = blocks
        .map((block) => block.left)
        .filter((value) => Number.isFinite(value))
        .sort((left, right) => left - right);

      if (leftPositions.length === 0) {
        return Number.POSITIVE_INFINITY;
      }

      const bands = [];
      for (const left of leftPositions) {
        const lastBand = bands[bands.length - 1];
        if (!lastBand || Math.abs(left - lastBand.max) > xBandTolerance) {
          bands.push({
            min: left,
            max: left,
            values: [left]
          });
          continue;
        }

        lastBand.max = left;
        lastBand.values.push(left);
      }

      if (bands.length < 2) {
        return Number.POSITIVE_INFINITY;
      }

      const mainBand = bands[0];
      const mainAnchor =
        mainBand.values.reduce((sum, value) => sum + value, 0) / mainBand.values.length;
      const replyBand = bands.find(
        (band, index) => index > 0 && band.min - mainAnchor >= replyIndentMinDelta
      );

      if (!replyBand) {
        return Number.POSITIVE_INFINITY;
      }

      return (mainAnchor + replyBand.min) / 2;
    };

    const replyIndentThreshold = resolveReplyIndentThreshold(rawBlocks);
    const orderedBlocks = rawBlocks
      .slice()
      .sort((left, right) =>
        left.top === right.top ? left.left - right.left : left.top - right.top
      );

    const comments = [];
    let currentMainComment = null;

    const flushCurrentMainComment = () => {
      if (!currentMainComment) {
        return;
      }

      const flushed = {
        domIndex: currentMainComment.domIndex,
        username: currentMainComment.username,
        commentText: currentMainComment.commentText,
        publishText: currentMainComment.publishText,
        signature: currentMainComment.signature,
        hasReplies: Boolean(currentMainComment.hasReplies),
        replyCount: currentMainComment.replyCount,
        order: currentMainComment.order
      };
      if (currentMainComment.imageUrls?.length > 0) {
        flushed.imageUrls = currentMainComment.imageUrls;
      }
      comments.push(flushed);

      currentMainComment = null;
    };

    for (const block of orderedBlocks) {
      const entry = block.entry;
      if (!entry?.signature) {
        continue;
      }

      const isReplyBlock =
        Number.isFinite(replyIndentThreshold) && block.left >= replyIndentThreshold;

      if (!isReplyBlock || !currentMainComment) {
        flushCurrentMainComment();
        currentMainComment = {
          domIndex: block.domIndex,
          username: entry.username,
          commentText: entry.commentText,
          publishText: entry.publishText,
          signature: entry.signature,
          hasReplies: Boolean(entry.hasReplies),
          replyCount: entry.replyCount,
          imageUrls: entry.imageUrls,
          order: block.domIndex
        };
        continue;
      }
    }

    flushCurrentMainComment();
    return comments;
  });
}

export function addCommentsFromSnapshot(commentsBySignature, snapshot) {
  let additions = 0;

  for (const comment of snapshot) {
    if (!comment.signature) {
      continue;
    }

    const existingComment = commentsBySignature.get(comment.signature);
    if (!existingComment) {
      commentsBySignature.set(comment.signature, comment);
      additions += 1;
      continue;
    }

    const mergedImageUrls =
      (comment.imageUrls?.length ?? 0) >= (existingComment.imageUrls?.length ?? 0)
        ? comment.imageUrls
        : existingComment.imageUrls;

    commentsBySignature.set(comment.signature, {
      ...existingComment,
      ...comment,
      hasReplies: Boolean(existingComment.hasReplies || comment.hasReplies),
      replyCount: Math.max(existingComment.replyCount ?? 0, comment.replyCount ?? 0),
      publishText:
        comment.publishText &&
        comment.publishText.length >= (existingComment.publishText ?? "").length
          ? comment.publishText
          : existingComment.publishText,
      imageUrls: mergedImageUrls,
      order:
        typeof existingComment.order === "number" && typeof comment.order === "number"
          ? Math.min(existingComment.order, comment.order)
          : typeof existingComment.order === "number"
            ? existingComment.order
            : comment.order
    });
  }

  return additions;
}
