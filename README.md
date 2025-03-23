# Cursor 配置同步插件

这个插件可以帮助你同步Cursor的配置文件，便于在多台设备之间同步配置。

## 功能特点

- 支持同步以下配置内容:
  - MCP配置文件 (mcp.json)
  - 扩展插件配置 (extensions.json)
  - 代码片段 (snippets)
  - 快捷键配置 (keybindings.json)
  - 设置配置 (settings.json)
  - 扩展目录同步

## 使用方法

### 配置GitHub

1. 首次使用时，会提示设置GitHub个人访问令牌（需要repo权限）
2. 输入GitHub用户名和令牌后，插件会自动验证连接
3. 如需修改，可在设置中更新`cursor-sync.githubToken`和`cursor-sync.githubUsername`

### 同步配置到GitHub

1. 点击状态栏中的"Cursor同步"图标，或运行命令`Cursor Sync: 显示同步菜单`
2. 选择"上传配置"选项
3. 如果GitHub仓库不存在，会提示你创建一个新仓库
4. 配置将被同步到GitHub仓库

### 从GitHub导入配置

1. 点击状态栏中的"Cursor同步"图标，或运行命令`Cursor Sync: 显示同步菜单`
2. 选择"恢复配置"选项
3. 确认后，将从GitHub下载配置到当前设备

### 配置要同步的扩展

在设置中编辑`cursor-sync.extensionsList`项，添加要同步的扩展ID，以逗号分隔

## 注意事项

- 同步会覆盖目标位置的现有文件
- 为避免冲突，建议在多台设备间切换时先同步再使用
- 若遇到同步错误，插件会显示详细错误信息
- 确保GitHub令牌具有正确的仓库访问权限

## 贡献

如有问题或建议，请提交issue或PR。

## 许可证

MIT