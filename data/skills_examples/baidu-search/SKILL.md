---
name: baidu-search
description: "使用百度 AI 搜索检索实时网络信息，并返回带来源链接的最新答案。用于近期新闻、价格、比分、时效性事实、事实核查，或用户明确要求联网搜索时。"
compatibility: "Requires Python 3, internet access, and the BAIDU_SEARCH_API_KEY environment variable."
---

# 百度 AI 搜索

通过宿主支持的环境变量配置方式提供 `BAIDU_SEARCH_API_KEY`。不要把密钥写入 Skill 文件、脚本参数或日志。

使用 Python 3 运行 `scripts/search.py`：

- `--query`：完整查询，必填。
- `--timeout`：HTTP 超时秒数，默认 `30`。

宿主执行超时应大于脚本的 HTTP 超时；使用默认值时至少预留 `45` 秒。

使用一条简洁且信息完整的查询。保留名称、日期、地点及其他必要约束，避免关键词片段产生歧义。

脚本将查询限制为 GB18030 编码后 `72` 字节，常用汉字通常占两个字节。查询过长时先压缩措辞，不要删除日期、地点等关键约束。

## 输出

执行成功时，从标准输出 JSON 的 `data` 中整理答案并附上相关来源链接。不要编造引用；除非用户明确要求，否则不要返回原始 JSON。

执行失败时，从标准错误 JSON 读取 `error`，并在包含 `next_step` 时给出该建议。缺少 API Key 时，明确提示用户为此技能配置 `BAIDU_SEARCH_API_KEY`；不要输出 API Key。
