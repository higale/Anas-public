# 配置说明

使用此 Skill 前，宿主环境必须提供：

- `BAILIAN_IMAGE_API_KEY`：阿里云 DashScope API Key；以 `sk-sp-` 开头的套餐 Key 自动使用北京 Token Plan 专属接口，其他 Key 使用普通北京 DashScope 接口。
- `BAILIAN_IMAGE_MODEL`：要调用的图片生成或编辑模型名称，也可通过 `--model` 为单次调用指定。

图片编辑需要模型支持图片输入；模型须在该 Key 所属地域及账户或套餐中可用。脚本固定使用北京接口，不支持通过参数切换地域。

脚本只依赖 Python 标准库，支持本地图片路径和 HTTP(S) 图片 URL，不需要额外安装 SDK。它返回结果 URL，不改写原图；需要永久保存时及时下载结果。

请通过宿主支持的环境变量配置方式提供这些值。不要把密钥写入 Skill 文件、脚本参数或日志。

接口依据：[Token Plan 多模态接入](https://help.aliyun.com/zh/model-studio/token-plan-multimodal-gen)、[千问图像生成与编辑](https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference)、[万相图像生成与编辑](https://help.aliyun.com/zh/model-studio/wan-image-generation-and-editing-api-reference)。
