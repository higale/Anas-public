# Anas 语言包 / Language Packs

## 中文

此目录保存界面语言包。应用会刷新内置文件，可能覆盖其内容：

- `en.json`
- `zh-CN.json`

添加自定义语言：

1. 将英文模板复制为新的语言文件，例如 `ja.json`、`ko.json`、`fr.json` 或 `pt-BR.json`。
2. 将 `_meta.name` 改为该语言的显示名称。
3. 翻译文本值，保留 JSON 键和 `{{name}}` 等占位符。
4. 将文件保存为 UTF-8 JSON。
5. 重启或重新打开 Anas，加载语言列表后在设置中选择新语言。

无需翻译所有键，缺失的键会回退到英文。文件结构见下方共用示例。

## English

This folder contains UI language packs. Built-in files are refreshed by the app and may be overwritten:

- `en.json`
- `zh-CN.json`

To add your own language:

1. Copy the English template file to a new language file. Example file names: ja.json, ko.json, fr.json, pt-BR.json.
2. Change `_meta.name` to the display name of your language.
3. Translate the text values. Keep JSON keys and placeholders such as `{{name}}` unchanged.
4. Save the file as UTF-8 JSON.
5. Restart or reopen Anas so the language list is loaded, then select your language in settings.

You do not need to translate every key. Missing keys fall back to English.

## 示例 / Example

```json
{
  "_meta": {
    "name": "Example Language",
    "author": "Your name"
  },
  "common": {
    "open": "Open",
    "reload": "Reload"
  }
}
```
