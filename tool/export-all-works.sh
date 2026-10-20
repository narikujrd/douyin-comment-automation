#!/usr/bin/env bash
# export-all-works.sh — 批量导出所有作品的评论
# 用法：bash export-all-works.sh
#       bash export-all-works.sh --headless   # 无头模式

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

WORKS_FILE="list-works.json"
OUTPUT_DIR="comments-output/all-works"
HEADLESS_FLAG=""

for arg in "$@"; do
  case "$arg" in
    --headless) HEADLESS_FLAG="--headless" ;;
  esac
done

# ── 前置检查 ──────────────────────────────────────────────
if [[ ! -f "$WORKS_FILE" ]]; then
  echo "错误：未找到 $WORKS_FILE，请先运行：npm run works"
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

# ── 读取作品列表（python3 解析 JSON）────────────────────────
works_data=$(python3 - "$WORKS_FILE" << 'PYEOF'
import json, sys
data = json.load(open(sys.argv[1]))
for w in data["works"]:
    # 输出 "标题\tpublishText"，以 tab 分隔，用 title 精确匹配避免短键随作品增长失效
    print(w["title"] + "\t" + w.get("publishText", ""))
PYEOF
)

TOTAL=$(echo "$works_data" | grep -c '.' || true)
SUCCESS=0
FAILED=0
FAILED_TITLES=()
NUM=0

echo "========================================"
echo " 批量导出作品评论"
echo " 作品总数：$TOTAL"
echo " 输出目录：$OUTPUT_DIR"
[[ -n "$HEADLESS_FLAG" ]] && echo " 模式：无头"
echo "========================================"
echo ""

while IFS=$'\t' read -r title publish_text; do
  [[ -z "$title" ]] && continue
  NUM=$((NUM + 1))

  # 文件名：去除不能用于文件名的字符
  safe_key=$(echo "$title" | tr -d '\/\\:*?"<>|' | tr ' ' '_')
  out_file="$OUTPUT_DIR/${safe_key}.json"

  echo "────────────────────────────────────────"
  echo "[$NUM/$TOTAL] $title"
  echo "  标题：$title → $out_file"

  if npm run comments:export-all -- $HEADLESS_FLAG "$title" \
    ${publish_text:+--work-publish-text "$publish_text"} \
    --out "$out_file" --limit 5000 2>&1; then
    count=$(python3 -c "import json; print(json.load(open('$out_file'))['count'])" 2>/dev/null || echo "?")
    echo "  ✓ 导出 ${count} 条评论"
    SUCCESS=$((SUCCESS + 1))
  else
    echo "  ✗ 导出失败，跳过"
    FAILED=$((FAILED + 1))
    FAILED_TITLES+=("$title")
  fi

  # 两个作品之间稍作间隔，避免请求过快
  if [[ $NUM -lt $TOTAL ]]; then
    sleep 3
  fi

  echo ""
done <<< "$works_data"

# ── 汇总 ──────────────────────────────────────────────────
echo "========================================"
echo " 全部完成"
echo " 成功：$SUCCESS / $TOTAL"
if [[ $FAILED -gt 0 ]]; then
  echo " 失败：$FAILED 个"
  for t in "${FAILED_TITLES[@]}"; do
    echo "   - $t"
  done
fi
echo "========================================"

# 生成一份汇总 JSON（合并所有作品的评论）
echo ""
echo "生成汇总文件..."
python3 - "$OUTPUT_DIR" << 'PYEOF'
import json, os, sys, glob

output_dir = sys.argv[1]
all_works = []
files = sorted(glob.glob(os.path.join(output_dir, "*.json")))
for f in files:
    try:
        data = json.load(open(f, encoding="utf-8"))
        all_works.append({
            "work": data.get("selectedWork", {}).get("title", os.path.basename(f)),
            "count": data.get("count", 0),
            "comments": data.get("comments", [])
        })
    except Exception as e:
        print(f"  跳过 {f}: {e}")

summary = {
    "totalWorks": len(all_works),
    "totalComments": sum(w["count"] for w in all_works),
    "works": all_works
}

out_path = os.path.join(os.path.dirname(output_dir), "all-works-summary.json")
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(summary, f, ensure_ascii=False, indent=2)

print(f"汇总完成：{len(all_works)} 个作品，共 {summary['totalComments']} 条评论")
print(f"汇总文件：{out_path}")
PYEOF
