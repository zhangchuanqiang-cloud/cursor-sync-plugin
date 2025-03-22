# Cursor 配置同步插件

这个插件可以帮助你同步Cursor的配置文件到iCloud云端，便于在多台设备之间同步配置。

## 功能特点

- 自动同步Cursor配置到iCloud指定目录
- 支持从iCloud导入配置到当前设备
- 监听配置文件变更，自动执行同步
- 支持同步以下配置内容:
  - MCP配置文件 (mcp.json)
  - 扩展插件配置 (extensions.json)
  - 代码片段 (snippets)
  - 快捷键配置 (keybindings.json)
  - 设置配置 (settings.json)
  - 特定的扩展目录 (如中文插件等)

## 使用方法

### 同步配置到云端

1. 运行命令 `Cursor Sync: 同步Cursor配置到云端`
2. 配置将被同步到iCloud目录: `~/Library/Mobile Documents/com~apple~CloudDocs/cursor-config-sync`

### 从云端导入配置

1. 运行命令 `Cursor Sync: 从云端导入Cursor配置`
2. 配置将从iCloud目录导入到当前设备

### 自动同步

1. 在设置中启用 `cursor-sync.autoSync` 选项
2. 当配置文件变更时，将自动同步到云端

## 要同步的特定扩展

- qianggaogao.vscode-gutter-preview-cn-0.32.2
- zh-community.insertseq-zh-0.10.1-zh

## 注意事项

- 同步会覆盖目标位置的现有文件
- 为避免冲突，建议在多台设备间切换时先同步再使用
- 若遇到同步错误，请查看控制台日志

## 贡献

如有问题或建议，请提交issue或PR。

## 许可证

MIT 