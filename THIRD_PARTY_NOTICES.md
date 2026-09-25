# 第三方声明 / Third-party notices

## 中文

Anas 使用 `LICENSE` 中的 MIT 协议。第三方代码和资源保留各自的版权和协议。

- OpenAI Codex：Skill 目录指导内容依据 Apache-2.0 使用，协议和署名位于 `data/licenses/codex/`。
- node-edge-tts：内置语音代码的署名和 MIT 协议位于 `data/licenses/node-edge-tts.txt`。
- `patches/` 中的依赖补丁会修改对应的上游包；重新分发时须保留这些包的协议声明。

源码分发包含 `data/licenses/` 下的内置声明。打包应用将其放在 `resources/data/licenses/` 下（macOS 上位于 `Contents/Resources/` 内）。应用归档中的依赖包在 `node_modules/` 下保留各自的声明。编译进渲染进程资源的构建时组件，其声明位于该归档的 `licenses/monaco-editor/`、`licenses/dompurify/` 和 `licenses/marked/` 下。

安装依赖或添加第三方 Skills、工具、模型和服务不会改变其协议条款。请查阅所分发内容附带的协议。

## English

Anas is licensed under the MIT License in `LICENSE`. Third-party code and assets retain their own copyrights and licenses.

- OpenAI Codex: Skill catalog guidance is used under Apache-2.0. The license and attribution are in `data/licenses/codex/`.
- node-edge-tts: bundled speech code attribution and MIT license are in `data/licenses/node-edge-tts.txt`.
- Dependency patches in `patches/` modify the corresponding upstream packages; retain those packages' license notices when redistributing them.

Source distributions include the bundled notices under `data/licenses/`. Packaged applications place them under `resources/data/licenses/` (under `Contents/Resources/` on macOS). Package dependencies retain their notices under `node_modules/` in the application archive. Build-time components shipped in renderer bundles have notices under `licenses/monaco-editor/`, `licenses/dompurify/`, and `licenses/marked/` in that archive.

Installing dependencies or adding third-party Skills, tools, models, or services does not change their license terms. Review the licenses supplied with anything you redistribute.
