import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as chokidar from 'chokidar';
import { Octokit } from '@octokit/rest';
import axios from 'axios';
import { Buffer } from 'buffer';

// 配置文件路径
const CONFIG_PATHS = {
    // MCP配置文件路径
    mcpPath: path.join(os.homedir(), '.cursor', 'mcp.json'),
    // 插件文件路径
    extensionsJsonPath: path.join(os.homedir(), '.cursor', 'extensions', 'extensions.json'),
    // 扩展目录
    extensionsDir: path.join(os.homedir(), '.cursor', 'extensions'),
    // 代码片段文件目录
    snippetsDir: path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'snippets'),
    // 快捷键配置文件路径
    keybindingsPath: path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'keybindings.json'),
    // 设置配置文件路径
    settingsPath: path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'settings.json')
};

// 需要特别同步的扩展目录列表
const SPECIAL_EXTENSIONS = [
    'qianggaogao.vscode-gutter-preview-cn-0.32.2',
    'zh-community.insertseq-zh-0.10.1-zh'
];

// 扩展目录中需要同步的文件类型
const EXTENSION_INCLUDE_PATTERNS = [
    /package\.json$/i,          // 扩展配置
    /README\.md$/i,             // 文档
    /\.json$/i,                 // JSON配置文件
    /\.vsixmanifest$/i,         // VSIX清单
    /icon\.(png|jpg|svg)$/i,    // 图标
    /LICENSE(\.txt)?$/i         // 许可证
];

// 默认配置
const DEFAULT_CONFIG = {
    syncExtensions: true,  // 默认同步扩展
    extensionsList: 'qianggaogao.vscode-gutter-preview-cn-0.32.2,zh-community.insertseq-zh-0.10.1-zh' // 默认同步的扩展列表
};

// 同步状态
let syncStatus: vscode.StatusBarItem;

// GitHub API 实例
let octokit: Octokit | null = null;

// 同步目标配置名称
enum SyncTarget {
    GITHUB = 'GitHub'
}

// 底部菜单项
interface MenuOption {
    label: string;
    command: string;
    detail?: string;
    icon?: string;
}

/**
 * 插件激活函数
 */
export function activate(context: vscode.ExtensionContext) {
    console.log('Cursor 配置同步插件已激活');

    // 初始化GitHub API
    initGitHubApi();

    // 创建状态栏项
    syncStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    syncStatus.text = '$(sync) Cursor同步';
    syncStatus.tooltip = 'Cursor配置同步状态';
    syncStatus.command = 'cursor-sync.showMenu';
    syncStatus.show();
    context.subscriptions.push(syncStatus);

    // 注册命令
    context.subscriptions.push(
        vscode.commands.registerCommand('cursor-sync.showMenu', showSyncMenu),
        vscode.commands.registerCommand('cursor-sync.syncToGithub', () => syncToGitHub()),
        vscode.commands.registerCommand('cursor-sync.syncFromGithub', () => syncFromGitHub()),
        vscode.commands.registerCommand('cursor-sync.toggleExtensionSync', toggleExtensionSync),
        vscode.commands.registerCommand('cursor-sync.openSettings', openSettings)
    );

    // 监听配置变更
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('cursor-sync.githubToken')) {
                // 如果GitHub令牌变更，重新初始化GitHub API
                initGitHubApi();
            }
        })
    );
}

/**
 * 同步配置到GitHub
 */
async function syncToGitHub(): Promise<void> {
    try {
        if (!octokit) {
            const result = await promptSetGitHubToken();
            if (!result) {
                return;
            }
        }

        // 验证GitHub连接
        const isConnected = await checkGitHubConnection();
        if (!isConnected) {
            void vscode.window.showErrorMessage('无法连接到GitHub，请检查网络连接和令牌有效性');
            updateSyncStatus('$(warning) GitHub连接失败', true);
            return;
        }

        // 默认使用强制覆盖模式
        const isForceMode = true;

        updateSyncStatus('$(sync~spin) 正在准备同步...', false);

        const config = vscode.workspace.getConfiguration('cursor-sync');
        const username = config.get<string>('githubUsername', '');
        const repoName = config.get<string>('githubRepo', 'cursor-sync');

        if (!username) {
            void vscode.window.showErrorMessage('未设置GitHub用户名，请在设置中配置');
            updateSyncStatus('$(alert) 同步失败', true);
            return;
        }

        // 检查仓库是否存在
        let repoExists = false;
        try {
            if (octokit) {
                await octokit.repos.get({
                    owner: username,
                    repo: repoName
                });
                console.log(`找到GitHub仓库: ${username}/${repoName}`);
                repoExists = true;
            }
        } catch (error) {
            // 仓库不存在，创建新仓库
            if ((error as any).status === 404) {
                updateSyncStatus('$(sync~spin) 仓库不存在', false);
                const shouldCreate = await vscode.window.showInformationMessage(
                    `GitHub仓库 ${username}/${repoName} 不存在，是否创建？`,
                    '是', '否'
                );

                if (shouldCreate === '是' && octokit) {
                    try {
                        updateSyncStatus('$(sync~spin) 正在创建仓库...', false);
                        await octokit.repos.createForAuthenticatedUser({
                            name: repoName,
                            description: 'Cursor配置同步仓库',
                            private: true
                        });
                        console.log(`已创建GitHub仓库 ${username}/${repoName}`);
                        void vscode.window.showInformationMessage(`已成功创建仓库 ${username}/${repoName}`);
                        repoExists = true;
                    } catch (createError) {
                        console.error(`创建仓库出错:`, createError);
                        handleSyncError(createError, '创建GitHub仓库');
                        return;
                    }
                } else {
                    void vscode.window.showErrorMessage('未创建GitHub仓库，同步已取消');
                    updateSyncStatus('$(alert) 同步已取消', true);
                    return;
                }
            } else {
                handleSyncError(error, '检查GitHub仓库');
                return;
            }
        }

        if (!repoExists || !octokit) {
            void vscode.window.showErrorMessage('仓库初始化失败，无法继续同步');
            updateSyncStatus('$(alert) 同步失败', true);
            return;
        }

        // 准备要同步的文件列表
        updateSyncStatus('$(sync~spin) 正在收集配置文件...', false);
        const filesToSync = [];

        // 添加基本配置文件
        const basicConfigs = [
            { localPath: CONFIG_PATHS.mcpPath, remotePath: 'mcp.json' },
            { localPath: CONFIG_PATHS.extensionsJsonPath, remotePath: 'extensions.json' },
            { localPath: CONFIG_PATHS.keybindingsPath, remotePath: 'keybindings.json' },
            { localPath: CONFIG_PATHS.settingsPath, remotePath: 'settings.json' }
        ];

        // 过滤出存在的文件
        for (const file of basicConfigs) {
            if (fs.existsSync(file.localPath)) {
                filesToSync.push(file);
            } else {
                console.log(`本地文件不存在，跳过: ${file.localPath}`);
            }
        }

        // 添加代码片段文件
        if (fs.existsSync(CONFIG_PATHS.snippetsDir)) {
            const snippetFiles = fs.readdirSync(CONFIG_PATHS.snippetsDir)
                .filter(file => file.endsWith('.json') || file.endsWith('.code-snippets'));

            for (const snippetFile of snippetFiles) {
                filesToSync.push({
                    localPath: path.join(CONFIG_PATHS.snippetsDir, snippetFile),
                    remotePath: `snippets/${snippetFile}`
                });
            }
        } else {
            console.log(`代码片段目录不存在，跳过: ${CONFIG_PATHS.snippetsDir}`);
        }

        // 添加特殊扩展文件
        const shouldSyncExtensions = config.get<boolean>('syncExtensions', DEFAULT_CONFIG.syncExtensions);
        if (shouldSyncExtensions) {
            // 从设置中获取扩展列表
            const extensionsListStr = config.get<string>('extensionsList', DEFAULT_CONFIG.extensionsList);
            const extensionsList = extensionsListStr.split(',').map(ext => ext.trim()).filter(ext => ext);

            for (const extName of extensionsList) {
                const extDir = path.join(CONFIG_PATHS.extensionsDir, extName);
                if (fs.existsSync(extDir)) {
                    const specificFiles = [ 'package.json', 'README.md', 'extension.vsixmanifest', 'extension.js' ];

                    for (const fileName of specificFiles) {
                        const filePath = path.join(extDir, fileName);
                        if (fs.existsSync(filePath)) {
                            filesToSync.push({
                                localPath: filePath,
                                remotePath: `extensions/${extName}/${fileName}`
                            });
                        }
                    }
                } else {
                    console.log(`扩展目录不存在，跳过: ${extDir}`);
                }
            }
        } else {
            console.log('根据配置，跳过同步扩展目录');
        }

        console.log(`准备同步 ${filesToSync.length} 个文件到GitHub`);

        // 开始批量上传文件
        updateSyncStatus(`$(sync~spin) 正在同步 ${filesToSync.length} 个文件...`, false);

        // 使用分批处理减轻API负担
        const BATCH_SIZE = 5;
        let successCount = 0;
        let failCount = 0;
        // 收集失败的文件及原因
        let failedFiles: Array<{ file: string, error: string }> = [];

        // 将文件列表分成小批次处理
        for (let i = 0; i < filesToSync.length; i += BATCH_SIZE) {
            const batch = filesToSync.slice(i, i + BATCH_SIZE);
            const batchPromises = batch.map(file => {
                updateSyncStatus(`$(sync~spin) 正在同步 ${i + 1}-${Math.min(i + BATCH_SIZE, filesToSync.length)}/${filesToSync.length}...`, false);
                return syncFileToGitHub(file.localPath, file.remotePath, username, repoName, isForceMode)
                    .then(() => { successCount++; })
                    .catch(err => {
                        const errorMsg = err.message || String(err);
                        console.error(`同步文件失败: ${file.remotePath}`, err);
                        failCount++;
                        failedFiles.push({
                            file: file.remotePath,
                            error: errorMsg
                        });
                        // 继续处理其他文件，不抛出异常中断整个过程
                    });
            });

            // 等待当前批次完成
            await Promise.all(batchPromises);
        }

        const totalResults = `成功: ${successCount}, 失败: ${failCount}, 总计: ${filesToSync.length}`;
        console.log(`同步完成，${totalResults}`);

        if (failCount === 0) {
            updateSyncStatus('$(check) 同步到GitHub完成', true, 5000);
        } else {
            updateSyncStatus('$(warning) 部分文件同步失败', true, 5000);

            // 仅当有失败文件时显示弹窗
            void vscode.window.showWarningMessage(`同步失败: ${failCount}/${filesToSync.length} 个文件同步失败`, '查看详情')
                .then(selection => {
                    if (selection === '查看详情') {
                        // 创建输出面板显示详细错误
                        const outputChannel = vscode.window.createOutputChannel('Cursor同步失败详情');
                        outputChannel.clear();
                        outputChannel.appendLine(`======== 同步失败详情 ========`);
                        outputChannel.appendLine(`成功: ${successCount}, 失败: ${failCount}, 总计: ${filesToSync.length}\n`);

                        failedFiles.forEach(item => {
                            outputChannel.appendLine(`文件: ${item.file}`);
                            outputChannel.appendLine(`错误: ${item.error}`);
                            outputChannel.appendLine('----------------------------');
                        });

                        outputChannel.show();
                    }
                });

            // 记录失败的详细信息到控制台
            console.error(`同步失败信息: 成功: ${successCount}, 失败: ${failCount}, 总计: ${filesToSync.length}`);
            failedFiles.forEach(item => {
                console.error(`- 文件 ${item.file}: ${item.error}`);
            });
        }
    } catch (error) {
        handleSyncError(error, '同步配置到GitHub');
    }
}

/**
 * 将文件同步到GitHub
 * @param localFilePath 本地文件路径
 * @param remoteFilePath GitHub上的文件路径
 * @param username GitHub用户名
 * @param repo 仓库名
 * @param forceOverwrite 是否强制覆盖
 */
async function syncFileToGitHub(localFilePath: string, remoteFilePath: string, username: string, repo: string, forceOverwrite: boolean = false): Promise<void> {
    try {
        if (!fs.existsSync(localFilePath)) {
            throw new Error(`本地文件不存在: ${localFilePath}`);
        }

        if (!octokit) {
            throw new Error('Octokit未初始化');
        }

        // 读取文件内容
        const content = fs.readFileSync(localFilePath, 'utf8');
        const fileBuffer = Buffer.from(content);
        const contentBase64 = fileBuffer.toString('base64');

        let isUpdate = false;
        let fileSha = '';

        try {
            // 先检查文件是否存在于GitHub
            const fileInfo = await octokit.repos.getContent({
                owner: username,
                repo: repo,
                path: remoteFilePath
            });

            isUpdate = true;

            if ('sha' in fileInfo.data) {
                fileSha = fileInfo.data.sha;
            } else if (Array.isArray(fileInfo.data) && fileInfo.data.length > 0 && 'sha' in fileInfo.data[ 0 ]) {
                fileSha = fileInfo.data[ 0 ].sha;
            }

            // 如果强制覆盖模式，直接使用获取到的SHA更新
            if (forceOverwrite) {
                console.log(`强制覆盖文件: ${remoteFilePath}`);
            } else {
                // 检查内容是否相同，相同则跳过更新
                let remoteContent = '';

                // 检查是否有content属性且为字符串类型
                if ('content' in fileInfo.data && typeof fileInfo.data.content === 'string') {
                    const base64Content = fileInfo.data.content.replace(/\n/g, '');
                    remoteContent = Buffer.from(base64Content, 'base64').toString('utf8');
                }

                if (remoteContent === content) {
                    console.log(`文件内容相同，跳过更新: ${remoteFilePath}`);
                    return;
                }
            }
        } catch (error) {
            // 文件不存在，创建新文件
            if ((error as any).status === 404) {
                isUpdate = false;
                console.log(`文件不存在，将创建: ${remoteFilePath}`);
            } else {
                // 其他错误，抛出异常
                throw error;
            }
        }

        try {
            if (isUpdate) {
                // 更新现有文件
                await octokit.repos.createOrUpdateFileContents({
                    owner: username,
                    repo: repo,
                    path: remoteFilePath,
                    message: `更新文件 ${remoteFilePath}${forceOverwrite ? ' (强制覆盖)' : ''}`,
                    content: contentBase64,
                    sha: fileSha
                });
                console.log(`已更新文件: ${remoteFilePath}`);
            } else {
                // 创建新文件
                await octokit.repos.createOrUpdateFileContents({
                    owner: username,
                    repo: repo,
                    path: remoteFilePath,
                    message: `创建文件 ${remoteFilePath}`,
                    content: contentBase64
                });
                console.log(`已创建文件: ${remoteFilePath}`);
            }
        } catch (error) {
            // 处理SHA冲突错误
            let isShaConflict = false;

            // 检查是否是SHA冲突，有多种错误信息格式需要处理
            if (isUpdate) {
                if ((error as any).status === 409 && (error as any).message &&
                    ((error as any).message.includes('SHA') ||
                        (error as any).message.includes('expected') ||
                        (error as any).message.match(/is at .* but expected .*/))) {
                    isShaConflict = true;
                }

                // 尝试从错误消息中提取正确的SHA
                const shaMatch = String(error).match(/is at ([a-f0-9]+) but expected/);
                let extractedSha = shaMatch ? shaMatch[ 1 ] : null;

                if (isShaConflict) {
                    console.log(`出现SHA冲突，尝试解决: ${remoteFilePath}`);

                    try {
                        if (extractedSha && extractedSha.length >= 40) {
                            // 如果能从错误消息中提取SHA，直接使用
                            console.log(`从错误消息中提取SHA: ${extractedSha.slice(0, 8)}...`);
                            fileSha = extractedSha;
                        } else {
                            // 否则重新获取最新的SHA
                            console.log(`重新获取文件SHA`);
                            const latestFileInfo = await octokit.repos.getContent({
                                owner: username,
                                repo: repo,
                                path: remoteFilePath
                            });

                            if ('sha' in latestFileInfo.data) {
                                fileSha = latestFileInfo.data.sha;
                            } else if (Array.isArray(latestFileInfo.data) && latestFileInfo.data.length > 0 && 'sha' in latestFileInfo.data[ 0 ]) {
                                fileSha = latestFileInfo.data[ 0 ].sha;
                            }
                        }

                        // 使用正确的SHA重试更新
                        await octokit.repos.createOrUpdateFileContents({
                            owner: username,
                            repo: repo,
                            path: remoteFilePath,
                            message: `更新文件 ${remoteFilePath} (SHA冲突修复${forceOverwrite ? '，强制覆盖' : ''})`,
                            content: contentBase64,
                            sha: fileSha
                        });
                        console.log(`使用正确SHA更新文件成功: ${remoteFilePath}`);
                    } catch (retryError) {
                        if (forceOverwrite) {
                            // 在强制覆盖模式下，尝试先删除文件再创建
                            console.log(`SHA冲突解决失败，尝试删除并重新创建文件: ${remoteFilePath}`);
                            try {
                                // 获取最新SHA，多次尝试不同的方法获取
                                let correctedSha = '';

                                // 1. 检查错误消息中是否包含"does not match"，可能包含正确的SHA
                                const doesNotMatchRegex = /does not match ([a-f0-9]+)/i;
                                const doesNotMatchResult = String(retryError).match(doesNotMatchRegex);
                                if (doesNotMatchResult && doesNotMatchResult[ 1 ] && doesNotMatchResult[ 1 ].length >= 40) {
                                    correctedSha = doesNotMatchResult[ 1 ];
                                    console.log(`从错误消息中提取SHA（does not match）: ${correctedSha.slice(0, 8)}...`);
                                }

                                // 2. 如果上面方法失败，再次尝试获取文件信息
                                if (!correctedSha) {
                                    console.log(`尝试重新获取文件SHA...`);
                                    try {
                                        const fileInfo = await octokit.repos.getContent({
                                            owner: username,
                                            repo: repo,
                                            path: remoteFilePath
                                        });

                                        if ('sha' in fileInfo.data) {
                                            correctedSha = fileInfo.data.sha;
                                        } else if (Array.isArray(fileInfo.data) && fileInfo.data.length > 0 && 'sha' in fileInfo.data[ 0 ]) {
                                            correctedSha = fileInfo.data[ 0 ].sha;
                                        }
                                        console.log(`获取到文件SHA: ${correctedSha.slice(0, 8)}...`);
                                    } catch (e) {
                                        console.error(`获取文件信息失败，将尝试使用原SHA或最后一次提取的SHA`);
                                    }
                                }

                                // 使用获取到的SHA，或者回退到之前可能已知的SHA
                                const shaToUse = correctedSha || fileSha;
                                if (!shaToUse || shaToUse.length < 40) {
                                    throw new Error(`无法获取有效的文件SHA，无法删除文件`);
                                }

                                console.log(`准备删除文件，使用SHA: ${shaToUse.slice(0, 8)}...`);

                                // 尝试删除文件
                                await octokit.repos.deleteFile({
                                    owner: username,
                                    repo: repo,
                                    path: remoteFilePath,
                                    message: `删除文件 ${remoteFilePath} (准备强制覆盖)`,
                                    sha: shaToUse
                                });

                                // 成功删除后，创建新文件
                                console.log(`文件删除成功，正在创建新文件...`);
                                await octokit.repos.createOrUpdateFileContents({
                                    owner: username,
                                    repo: repo,
                                    path: remoteFilePath,
                                    message: `创建文件 ${remoteFilePath} (强制覆盖)`,
                                    content: contentBase64
                                });
                                console.log(`通过删除并重新创建成功更新文件: ${remoteFilePath}`);
                            } catch (finalError: any) {
                                // 如果删除也失败，尝试一种最终的方法：使用低级Git API方式
                                try {
                                    console.log(`删除文件失败，尝试使用低级Git API覆盖（最终方案）...`);

                                    // 获取仓库默认分支信息...
                                    console.log(`获取仓库默认分支信息...`);
                                    const repoInfo = await octokit.repos.get({
                                        owner: username,
                                        repo: repo
                                    });
                                    const defaultBranch = repoInfo.data.default_branch || 'main';
                                    console.log(`仓库默认分支: ${defaultBranch}`);

                                    // 创建blob
                                    console.log(`创建文件内容blob...`);
                                    const blobResult = await octokit.git.createBlob({
                                        owner: username,
                                        repo: repo,
                                        content: contentBase64,
                                        encoding: 'base64'
                                    });

                                    // 获取最新的引用（默认分支）
                                    console.log(`获取分支引用: heads/${defaultBranch}`);
                                    const refResponse = await octokit.git.getRef({
                                        owner: username,
                                        repo: repo,
                                        ref: `heads/${defaultBranch}`
                                    });

                                    // 获取最新提交
                                    console.log(`获取最新提交: ${refResponse.data.object.sha.substring(0, 8)}...`);
                                    const commitResponse = await octokit.git.getCommit({
                                        owner: username,
                                        repo: repo,
                                        commit_sha: refResponse.data.object.sha
                                    });

                                    // 获取完整的树
                                    console.log(`获取当前树: ${commitResponse.data.tree.sha.substring(0, 8)}...`);
                                    const treeResponse = await octokit.git.getTree({
                                        owner: username,
                                        repo: repo,
                                        tree_sha: commitResponse.data.tree.sha,
                                        recursive: '1'
                                    });

                                    // 准备新的树结构，保留原有树结构，只更新目标文件
                                    const newTree: Array<{
                                        path: string;
                                        mode: "100644" | "100755" | "040000" | "160000" | "120000";
                                        type: "blob" | "tree" | "commit";
                                        sha: string | null;
                                    }> = [];

                                    // 从原树中复制所需项目，确保类型正确
                                    for (const item of treeResponse.data.tree) {
                                        if (item.path && item.mode && item.type && item.sha) {
                                            // 确保模式和类型符合要求
                                            const mode = item.mode as "100644" | "100755" | "040000" | "160000" | "120000";
                                            const type = item.type as "blob" | "tree" | "commit";

                                            newTree.push({
                                                path: item.path,
                                                mode: mode,
                                                type: type,
                                                sha: item.sha
                                            });
                                        }
                                    }

                                    // 准备文件路径（确保路径格式正确）
                                    let treePath = remoteFilePath;
                                    // 移除前导斜杠（如果有）
                                    if (treePath.startsWith('/')) {
                                        treePath = treePath.substring(1);
                                    }

                                    // 查找并更新或添加目标文件
                                    let fileFound = false;
                                    for (let i = 0; i < newTree.length; i++) {
                                        if (newTree[ i ].path === treePath) {
                                            newTree[ i ].sha = blobResult.data.sha;
                                            fileFound = true;
                                            break;
                                        }
                                    }

                                    // 如果文件不存在于树结构中，则添加
                                    if (!fileFound) {
                                        newTree.push({
                                            path: treePath,
                                            mode: "100644",
                                            type: "blob",
                                            sha: blobResult.data.sha
                                        });
                                    }

                                    // 创建新树，保留现有结构，只修改目标文件
                                    console.log(`创建新的树结构...`);
                                    const createTreeResponse = await octokit.git.createTree({
                                        owner: username,
                                        repo: repo,
                                        tree: newTree
                                    });

                                    // 创建新提交
                                    console.log(`创建新的提交...`);
                                    const newCommit = await octokit.git.createCommit({
                                        owner: username,
                                        repo: repo,
                                        message: `通过低级Git API强制覆盖文件 ${remoteFilePath}`,
                                        tree: createTreeResponse.data.sha,
                                        parents: [ refResponse.data.object.sha ]
                                    });

                                    // 更新引用指向新提交
                                    console.log(`更新分支引用指向新提交...`);
                                    await octokit.git.updateRef({
                                        owner: username,
                                        repo: repo,
                                        ref: `heads/${defaultBranch}`,
                                        sha: newCommit.data.sha,
                                        force: true // 强制更新
                                    });

                                    console.log(`通过低级Git API成功覆盖文件: ${remoteFilePath}`);
                                } catch (apiError) {
                                    console.error(`低级API覆盖也失败: ${remoteFilePath}`, apiError);
                                    console.error(apiError);

                                    // 作为最后的尝试，使用PUT方法直接更新文件
                                    try {
                                        console.log(`尝试使用PUT方法直接更新文件（最终紧急方案）...`);

                                        // 使用最原始的方式：直接PUT请求更新文件
                                        const token = vscode.workspace.getConfiguration('cursor-sync').get<string>('githubToken', '');
                                        if (!token) {
                                            throw new Error('未设置GitHub令牌');
                                        }

                                        // 确保路径格式正确
                                        let apiPath = remoteFilePath;
                                        if (apiPath.startsWith('/')) {
                                            apiPath = apiPath.substring(1);
                                        }

                                        // 使用axios发送直接请求
                                        const apiUrl = `https://api.github.com/repos/${username}/${repo}/contents/${apiPath}`;

                                        // 先获取文件信息
                                        const fileResponse = await axios.get(apiUrl, {
                                            headers: {
                                                'Authorization': `token ${token}`,
                                                'Accept': 'application/vnd.github.v3+json',
                                                'User-Agent': 'Cursor-Sync-Extension'
                                            }
                                        });

                                        // 然后使用PUT更新文件
                                        await axios.put(apiUrl, {
                                            message: `强制更新文件 ${remoteFilePath} (紧急方案)`,
                                            content: contentBase64,
                                            sha: fileResponse.data.sha
                                        }, {
                                            headers: {
                                                'Authorization': `token ${token}`,
                                                'Accept': 'application/vnd.github.v3+json',
                                                'User-Agent': 'Cursor-Sync-Extension'
                                            }
                                        });

                                        console.log(`通过直接PUT请求成功覆盖文件: ${remoteFilePath}`);
                                    } catch (directError) {
                                        console.error(`所有方法均已失败，无法更新文件: ${remoteFilePath}`, directError);
                                        throw new Error(`无法强制覆盖文件 ${remoteFilePath} - 已尝试所有可能的方法`);
                                    }
                                }
                            }
                        } else {
                            throw retryError;
                        }
                    }
                } else {
                    throw error; // 其他错误，抛出异常
                }
            } else {
                throw error; // 如果是创建新文件出错，抛出异常
            }
        }
    } catch (error) {
        console.error(`同步文件到GitHub失败: ${remoteFilePath}`, error);
        throw error;
    }
}

/**
 * 同步目录到GitHub
 */
async function syncDirectoryToGitHub(
    sourceDir: string,
    targetDir: string,
    username: string,
    repoName: string,
    forceOverwrite: boolean = false
): Promise<void> {
    try {
        if (!fs.existsSync(sourceDir)) {
            console.log(`源目录不存在，跳过: ${sourceDir}`);
            return;
        }

        // 确定是否是扩展目录
        const isExtensionDir = sourceDir.includes(CONFIG_PATHS.extensionsDir);

        console.log(`正在同步目录到GitHub: ${sourceDir} -> ${targetDir}${forceOverwrite ? ' (强制覆盖模式)' : ''}`);

        // 如果是扩展目录，只同步重要的配置文件
        if (isExtensionDir) {
            const specificFiles = [
                'package.json',
                'README.md',
                'extension.vsixmanifest',
                'extension.js'
            ];

            let fileCount = 0;
            for (const fileName of specificFiles) {
                const filePath = path.join(sourceDir, fileName);
                if (fs.existsSync(filePath)) {
                    const targetPath = path.posix.join(targetDir, fileName);
                    await syncFileToGitHub(filePath, targetPath, username, repoName, forceOverwrite);
                    fileCount++;
                }
            }

            console.log(`扩展目录同步完成: ${sourceDir}, 成功同步 ${fileCount} 个文件`);
            return;
        }

        // 对于代码片段目录，只同步根目录下的JSON文件
        if (targetDir === 'snippets') {
            if (!fs.existsSync(sourceDir)) {
                console.log(`代码片段目录不存在，跳过: ${sourceDir}`);
                return;
            }

            const files = fs.readdirSync(sourceDir)
                .filter(file => file.endsWith('.json') || file.endsWith('.code-snippets'))
                .map(file => path.join(sourceDir, file));

            console.log(`发现 ${files.length} 个代码片段文件`);

            let uploadedCount = 0;
            for (const file of files) {
                try {
                    const fileName = path.basename(file);
                    const targetPath = path.posix.join(targetDir, fileName);
                    await syncFileToGitHub(file, targetPath, username, repoName, forceOverwrite);
                    uploadedCount++;
                } catch (error) {
                    console.error(`同步代码片段文件失败: ${file}`, error);
                }
            }

            console.log(`代码片段同步完成: ${sourceDir}, 成功同步 ${uploadedCount}/${files.length} 个文件`);
            return;
        }

        // 其他情况使用之前的递归搜索方法（保留以防有其他类型的目录需要同步）
        const maxDepth = 1; // 只搜索当前目录，不递归
        console.log(`使用浅层搜索同步目录: ${sourceDir}`);
        const files = getFilesInDirectory(sourceDir, maxDepth);

        let uploadedCount = 0;
        const MAX_FILES = 10; // 限制每个目录最多同步10个文件

        for (const file of files.slice(0, MAX_FILES)) {
            try {
                const relativePath = path.relative(sourceDir, file);
                const targetPath = path.posix.join(targetDir, relativePath.split(path.sep).join(path.posix.sep));
                await syncFileToGitHub(file, targetPath, username, repoName, forceOverwrite);
                uploadedCount++;
            } catch (error) {
                console.error(`同步文件到GitHub失败: ${file}`, error);
            }
        }

        console.log(`目录同步完成: ${sourceDir}, 成功同步 ${uploadedCount}/${Math.min(files.length, MAX_FILES)} 个文件`);
    } catch (error) {
        console.error(`同步目录到GitHub失败: ${sourceDir}`, error);
        throw error;
    }
}

/**
 * 提示用户设置GitHub令牌
 */
async function promptSetGitHubToken(): Promise<boolean> {
    const message = '需要GitHub个人访问令牌来访问仓库，是否设置？';
    const answer = await vscode.window.showInformationMessage(message, '设置', '取消');

    if (answer === '设置') {
        const token = await vscode.window.showInputBox({
            prompt: '请输入GitHub个人访问令牌(需要repo权限)',
            password: true
        });

        if (token) {
            const config = vscode.workspace.getConfiguration('cursor-sync');
            await config.update('githubToken', token, vscode.ConfigurationTarget.Global);

            // 再次提示输入用户名
            const username = await vscode.window.showInputBox({
                prompt: '请输入GitHub用户名'
            });

            if (username) {
                await config.update('githubUsername', username, vscode.ConfigurationTarget.Global);
                initGitHubApi();
                return true;
            }
        }
    }

    return false;
}

/**
 * 验证GitHub连接
 */
async function checkGitHubConnection(): Promise<boolean> {
    try {
        if (!octokit) {
            return false;
        }

        const response = await octokit.rateLimit.get();
        return response.status === 200;
    } catch (error) {
        console.error('GitHub连接验证失败:', error);
        return false;
    }
}

/**
 * 更新状态栏显示
 */
function updateSyncStatus(status: string, isTemporary: boolean = true, durationMs: number = 3000): void {
    syncStatus.text = status;

    if (isTemporary) {
        setTimeout(() => {
            syncStatus.text = '$(sync) Cursor同步';
        }, durationMs);
    }
}

/**
 * 处理同步错误
 */
function handleSyncError(error: any, operation: string): void {
    console.error(`${operation}错误:`, error);

    let errorMessage = `${operation}失败`;

    if (error instanceof Error) {
        errorMessage += `: ${error.message}`;
    } else if (typeof error === 'string') {
        errorMessage += `: ${error}`;
    }

    // 检查是否是API速率限制错误
    if (error.status === 403 && error.headers && error.headers[ 'x-ratelimit-remaining' ] === '0') {
        const resetTime = new Date(parseInt(error.headers[ 'x-ratelimit-reset' ]) * 1000);
        errorMessage = `GitHub API速率限制已达到，请在${resetTime.toLocaleTimeString()}后重试`;
    }

    updateSyncStatus('$(alert) 同步失败', true);
    void vscode.window.showErrorMessage(errorMessage);
}

/**
 * 显示同步菜单
 */
async function showSyncMenu(): Promise<void> {
    // 获取当前扩展同步状态
    const config = vscode.workspace.getConfiguration('cursor-sync');
    const isExtSyncEnabled = config.get<boolean>('syncExtensions', DEFAULT_CONFIG.syncExtensions);
    const extSyncStatus = isExtSyncEnabled ? '禁用' : '启用';

    const options: MenuOption[] = [
        {
            label: '$(cloud-upload) 上传配置',
            command: 'cursor-sync.syncToGithub',
            detail: '上传配置到GitHub',
            icon: '$(cloud-upload)'
        },
        {
            label: '$(cloud-download) 恢复配置',
            command: 'cursor-sync.syncFromGithub',
            detail: '从GitHub下载配置',
            icon: '$(cloud-download)'
        },
        {
            label: `$(extensions) ${extSyncStatus}扩展同步`,
            command: 'cursor-sync.toggleExtensionSync',
            detail: `${extSyncStatus}特殊扩展目录的同步`,
            icon: '$(extensions)'
        },
        {
            label: '$(gear) 设置',
            command: 'cursor-sync.openSettings',
            detail: '打开配置同步设置',
            icon: '$(gear)'
        }
    ];

    const selected = await vscode.window.showQuickPick(
        options.map(option => ({
            label: option.label,
            description: '',
            detail: option.detail,
            option
        })),
        {
            placeHolder: '选择一个操作'
        }
    );

    if (selected) {
        if (selected.option.command === 'cursor-sync.toggleExtensionSync') {
            await toggleExtensionSync();
        } else {
            vscode.commands.executeCommand(selected.option.command);
        }
    }
}

/**
 * 获取当前的同步目标
 */
function getCurrentSyncTarget(): SyncTarget {
    return SyncTarget.GITHUB;
}

/**
 * 打开扩展同步配置
 */
async function toggleExtensionSync(): Promise<void> {
    const config = vscode.workspace.getConfiguration('cursor-sync');
    const currentValue = config.get<boolean>('syncExtensions', DEFAULT_CONFIG.syncExtensions);

    // 切换值
    await config.update('syncExtensions', !currentValue, vscode.ConfigurationTarget.Global);

    // 显示确认信息
    const newStatus = !currentValue ? '启用' : '禁用';
    void vscode.window.showInformationMessage(`已${newStatus}扩展目录同步`);

    // 更新状态栏
    updateSyncStatus(`$(info) 已${newStatus}扩展同步`, true);
}

/**
 * 打开设置
 */
function openSettings(): void {
    vscode.commands.executeCommand('workbench.action.openSettings', 'cursor-sync');
}

/**
 * 确保目录存在
 */
function ensureDirectoryExists(dirPath: string): void {
    try {
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
            console.log(`创建目录: ${dirPath}`);
        }
    } catch (error) {
        void vscode.window.showErrorMessage(`无法创建目录 ${dirPath}: ${error}`);
        console.error(`无法创建目录 ${dirPath}:`, error);
    }
}

/**
 * 插件停用函数
 */
export function deactivate() {
    console.log('Cursor 配置同步插件已停用');
}

/**
 * 获取目录中的所有文件（包括子目录中的文件）
 */
function getFilesInDirectory(dir: string, maxDepth: number = 3): string[] {
    const files: string[] = [];

    // 定义需要忽略的目录和文件模式
    const ignoredDirs = [ '.git', 'node_modules', 'dist', '.vscode-test', 'out' ];
    const ignoredPatterns = [
        /\.vsix$/i,       // VSIX文件
        /\.log$/i,        // 日志文件
        /\.tmp$/i,        // 临时文件
        /\.DS_Store$/i,   // macOS系统文件
        /Thumbs\.db$/i,   // Windows缩略图缓存
        /desktop\.ini$/i  // Windows桌面设置
    ];

    function shouldIgnore(filePath: string): boolean {
        const fileName = path.basename(filePath);

        // 检查是否是忽略的文件类型
        for (const pattern of ignoredPatterns) {
            if (pattern.test(fileName)) {
                return true;
            }
        }

        return false;
    }

    function traverseDirectory(currentDir: string, depth: number = 0) {
        if (depth > maxDepth) {
            console.log(`达到最大递归深度(${maxDepth})，跳过深层目录: ${currentDir}`);
            return;
        }

        try {
            const entries = fs.readdirSync(currentDir, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(currentDir, entry.name);

                if (entry.isDirectory()) {
                    // 跳过忽略的目录
                    if (ignoredDirs.includes(entry.name)) {
                        console.log(`跳过忽略的目录: ${fullPath}`);
                        continue;
                    }

                    traverseDirectory(fullPath, depth + 1);
                } else if (!shouldIgnore(fullPath)) {
                    files.push(fullPath);
                } else {
                    console.log(`跳过忽略的文件: ${fullPath}`);
                }
            }
        } catch (error) {
            console.error(`读取目录失败: ${currentDir}`, error);
        }
    }

    traverseDirectory(dir);
    return files;
}

/**
 * 初始化GitHub API
 */
function initGitHubApi(): void {
    const config = vscode.workspace.getConfiguration('cursor-sync');
    const token = config.get<string>('githubToken', '');

    if (token) {
        try {
            octokit = new Octokit({
                auth: token
            });
            console.log('GitHub API 已初始化');
        } catch (error) {
            console.error('初始化GitHub API失败:', error);
        }
    } else {
        octokit = null;
    }
}

/**
 * 确认同步操作
 */
async function confirmSyncOperation(message: string): Promise<boolean> {
    const choice = await vscode.window.showInformationMessage(
        message,
        '确认',
        '取消'
    );

    return choice === '确认';
}

/**
 * 从GitHub同步配置
 */
async function syncFromGitHub(): Promise<void> {
    try {
        if (!octokit) {
            const result = await promptSetGitHubToken();
            if (!result) {
                return;
            }
        }

        // 验证GitHub连接
        const isConnected = await checkGitHubConnection();
        if (!isConnected) {
            void vscode.window.showErrorMessage('无法连接到GitHub，请检查网络连接和令牌有效性');
            updateSyncStatus('$(warning) GitHub连接失败', true);
            return;
        }

        // 确认操作
        const confirmOption = await vscode.window.showInformationMessage(
            '确认从GitHub恢复配置？这将覆盖本地配置文件。',
            { modal: true },
            '恢复', '取消'
        );

        if (confirmOption !== '恢复') {
            updateSyncStatus('$(info) 恢复已取消', true);
            return;
        }

        // 默认使用强制覆盖模式
        const isForceMode = true;

        updateSyncStatus('$(sync~spin) 正在从GitHub获取配置...', false);

        const config = vscode.workspace.getConfiguration('cursor-sync');
        const username = config.get<string>('githubUsername', '');
        const repoName = config.get<string>('githubRepo', 'cursor-sync');

        if (!username) {
            void vscode.window.showErrorMessage('未设置GitHub用户名，请在设置中配置');
            updateSyncStatus('$(alert) 恢复失败', true);
            return;
        }

        // 检查仓库是否存在
        try {
            if (octokit) {
                await octokit.repos.get({
                    owner: username,
                    repo: repoName
                });
                console.log(`找到GitHub仓库: ${username}/${repoName}`);
            }
        } catch (error) {
            if ((error as any).status === 404) {
                void vscode.window.showErrorMessage(`GitHub仓库 ${username}/${repoName} 不存在，请先同步配置到GitHub`);
                updateSyncStatus('$(alert) 仓库不存在', true);
                return;
            } else {
                handleSyncError(error, '检查GitHub仓库');
                return;
            }
        }

        // 准备要同步的文件列表
        updateSyncStatus('$(sync~spin) 正在获取远程文件列表...', false);
        const filesToSync = [];

        // 添加基本配置文件
        const basicConfigs = [
            { remotePath: 'mcp.json', localPath: CONFIG_PATHS.mcpPath },
            { remotePath: 'extensions.json', localPath: CONFIG_PATHS.extensionsJsonPath },
            { remotePath: 'keybindings.json', localPath: CONFIG_PATHS.keybindingsPath },
            { remotePath: 'settings.json', localPath: CONFIG_PATHS.settingsPath }
        ];

        // 确保目标目录存在
        for (const file of basicConfigs) {
            const localDir = path.dirname(file.localPath);
            if (!fs.existsSync(localDir)) {
                fs.mkdirSync(localDir, { recursive: true });
            }
            filesToSync.push(file);
        }

        // 获取代码片段列表
        try {
            if (!octokit) {
                throw new Error('Octokit未初始化');
            }

            const snippetsResponse = await octokit.repos.getContent({
                owner: username,
                repo: repoName,
                path: 'snippets'
            });

            if (Array.isArray(snippetsResponse.data)) {
                // 只处理JSON和代码片段文件
                const jsonFiles = snippetsResponse.data.filter(item =>
                    item.type === 'file' &&
                    (item.name.endsWith('.json') || item.name.endsWith('.code-snippets'))
                );

                // 确保代码片段目录存在
                if (!fs.existsSync(CONFIG_PATHS.snippetsDir)) {
                    fs.mkdirSync(CONFIG_PATHS.snippetsDir, { recursive: true });
                }

                for (const file of jsonFiles) {
                    filesToSync.push({
                        remotePath: `snippets/${file.name}`,
                        localPath: path.join(CONFIG_PATHS.snippetsDir, file.name)
                    });
                }

                console.log(`在GitHub发现 ${jsonFiles.length} 个代码片段文件`);
            }
        } catch (error) {
            if ((error as any).status !== 404) {
                console.error('获取代码片段目录失败:', error);
            }
            // 如果是404，说明没有snippets目录，跳过即可
        }

        // 添加特殊扩展文件
        const shouldSyncExtensions = config.get<boolean>('syncExtensions', DEFAULT_CONFIG.syncExtensions);
        if (shouldSyncExtensions) {
            // 从设置中获取扩展列表
            const extensionsListStr = config.get<string>('extensionsList', DEFAULT_CONFIG.extensionsList);
            const extensionsList = extensionsListStr.split(',').map(ext => ext.trim()).filter(ext => ext);

            for (const extName of extensionsList) {
                try {
                    if (!octokit) {
                        throw new Error('Octokit未初始化');
                    }

                    const extResponse = await octokit.repos.getContent({
                        owner: username,
                        repo: repoName,
                        path: `extensions/${extName}`
                    });

                    if (Array.isArray(extResponse.data)) {
                        // 确保扩展目录存在
                        const extDir = path.join(CONFIG_PATHS.extensionsDir, extName);
                        if (!fs.existsSync(extDir)) {
                            fs.mkdirSync(extDir, { recursive: true });
                        }

                        const specificFiles = [ 'package.json', 'README.md', 'extension.vsixmanifest', 'extension.js' ];

                        for (const item of extResponse.data) {
                            if (item.type === 'file' && specificFiles.includes(item.name)) {
                                filesToSync.push({
                                    remotePath: `extensions/${extName}/${item.name}`,
                                    localPath: path.join(extDir, item.name)
                                });
                            }
                        }
                    }
                } catch (error) {
                    if ((error as any).status !== 404) {
                        console.error(`获取扩展目录失败: ${extName}`, error);
                    }
                    // 如果是404，说明没有该扩展目录，跳过即可
                }
            }
        } else {
            console.log('根据配置，跳过同步扩展目录');
        }

        console.log(`准备从GitHub同步 ${filesToSync.length} 个文件`);

        // 开始批量下载文件
        updateSyncStatus(`$(sync~spin) 正在恢复 ${filesToSync.length} 个文件...`, false);

        // 使用分批处理减轻API负担
        const BATCH_SIZE = 5;
        let successCount = 0;
        let failCount = 0;
        // 收集失败的文件及原因
        let failedFiles: Array<{ file: string, error: string }> = [];

        // 将文件列表分成小批次处理
        for (let i = 0; i < filesToSync.length; i += BATCH_SIZE) {
            const batch = filesToSync.slice(i, i + BATCH_SIZE);
            const batchPromises = batch.map(file => {
                updateSyncStatus(`$(sync~spin) 正在恢复 ${i + 1}-${Math.min(i + BATCH_SIZE, filesToSync.length)}/${filesToSync.length}...`, false);
                return syncFileFromGitHub(file.remotePath, file.localPath, username, repoName, isForceMode)
                    .then(() => { successCount++; })
                    .catch(err => {
                        // 如果文件不存在，不增加失败计数
                        if ((err as any).status === 404) {
                            console.log(`远程文件不存在，跳过: ${file.remotePath}`);
                        } else {
                            console.error(`恢复文件失败: ${file.remotePath}`, err);
                            failCount++;
                            failedFiles.push({
                                file: file.remotePath,
                                error: err.message || String(err)
                            });
                        }
                        // 继续处理其他文件，不抛出异常中断整个过程
                    });
            });

            // 等待当前批次完成
            await Promise.all(batchPromises);
        }

        const totalResults = `成功: ${successCount}, 失败: ${failCount}, 总计: ${filesToSync.length}`;
        console.log(`恢复完成，${totalResults}`);

        if (failCount === 0) {
            updateSyncStatus('$(check) 从GitHub恢复完成', true, 5000);
        } else {
            updateSyncStatus('$(warning) 部分文件恢复失败', true, 5000);

            // 仅当有失败文件时显示弹窗
            void vscode.window.showWarningMessage(`恢复失败: ${failCount}/${filesToSync.length} 个文件恢复失败`, '查看详情')
                .then(selection => {
                    if (selection === '查看详情') {
                        // 创建输出面板显示详细错误
                        const outputChannel = vscode.window.createOutputChannel('Cursor恢复失败详情');
                        outputChannel.clear();
                        outputChannel.appendLine(`======== 恢复失败详情 ========`);
                        outputChannel.appendLine(`成功: ${successCount}, 失败: ${failCount}, 总计: ${filesToSync.length}\n`);

                        failedFiles.forEach(item => {
                            outputChannel.appendLine(`文件: ${item.file}`);
                            outputChannel.appendLine(`错误: ${item.error}`);
                            outputChannel.appendLine('----------------------------');
                        });

                        outputChannel.show();
                    }
                });

            // 记录失败的详细信息到控制台
            console.error(`恢复失败信息: 成功: ${successCount}, 失败: ${failCount}, 总计: ${filesToSync.length}`);
            failedFiles.forEach(item => {
                console.error(`- 文件 ${item.file}: ${item.error}`);
            });
        }
    } catch (error) {
        handleSyncError(error, '从GitHub恢复配置');
    }
}

/**
 * 从GitHub同步文件
 * @param remoteFilePath GitHub上的文件路径
 * @param localFilePath 本地文件路径
 * @param username GitHub用户名
 * @param repo 仓库名
 * @param forceOverwrite 是否强制覆盖
 */
async function syncFileFromGitHub(remoteFilePath: string, localFilePath: string, username: string, repo: string, forceOverwrite: boolean = false): Promise<void> {
    try {
        if (!octokit) {
            throw new Error('Octokit未初始化');
        }

        // 获取GitHub上的文件
        const fileInfo = await octokit.repos.getContent({
            owner: username,
            repo: repo,
            path: remoteFilePath
        });

        if (!('content' in fileInfo.data) || typeof fileInfo.data.content !== 'string') {
            throw new Error(`获取文件内容失败: ${remoteFilePath}`);
        }

        // 解码Base64内容
        const base64Content = fileInfo.data.content.replace(/\n/g, '');
        const content = Buffer.from(base64Content, 'base64').toString('utf8');

        // 确保目标目录存在
        const dirPath = path.dirname(localFilePath);
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }

        // 检查是否需要更新
        if (!forceOverwrite && fs.existsSync(localFilePath)) {
            const localContent = fs.readFileSync(localFilePath, 'utf8');
            if (localContent === content) {
                console.log(`文件内容相同，跳过恢复: ${localFilePath}`);
                return;
            }
        }

        // 写入文件
        fs.writeFileSync(localFilePath, content, 'utf8');
        console.log(`已从GitHub恢复文件: ${localFilePath}`);
    } catch (error) {
        // 如果是404错误，文件不存在，提供更明确的错误
        if ((error as any).status === 404) {
            throw new Error(`GitHub上不存在该文件: ${remoteFilePath}`);
        }
        console.error(`从GitHub同步文件失败: ${remoteFilePath}`, error);
        throw error;
    }
}

/**
 * 从GitHub同步目录
 */
async function syncDirectoryFromGitHub(
    sourceDir: string,
    targetDir: string,
    username: string,
    repoName: string,
    forceOverwrite: boolean = false
): Promise<void> {
    try {
        if (!octokit) {
            throw new Error('GitHub API未初始化');
        }

        // 确保目录存在
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        // 确定是否是扩展目录
        const isExtensionDir = targetDir.includes(CONFIG_PATHS.extensionsDir);

        console.log(`正在从GitHub同步目录: ${sourceDir} -> ${targetDir}${forceOverwrite ? ' (强制覆盖模式)' : ''}`);

        try {
            // 扩展目录，只同步特定文件
            if (isExtensionDir) {
                const specificFiles = [
                    'package.json',
                    'README.md',
                    'extension.vsixmanifest',
                    'extension.js'
                ];

                let downloadedCount = 0;
                for (const fileName of specificFiles) {
                    try {
                        const remotePath = `${sourceDir}/${fileName}`;
                        const localPath = path.join(targetDir, fileName);
                        await syncFileFromGitHub(remotePath, localPath, username, repoName, forceOverwrite);
                        downloadedCount++;
                    } catch (error) {
                        if ((error as any).status !== 404) {
                            console.error(`同步扩展文件失败: ${fileName}`, error);
                        }
                        // 404表示文件不存在，跳过
                    }
                }

                console.log(`扩展目录同步完成: ${targetDir}, 成功下载 ${downloadedCount} 个文件`);
                return;
            }

            // 对于代码片段目录，只获取根目录下的文件
            if (sourceDir === 'snippets') {
                // 获取GitHub上的目录内容
                const response = await octokit.repos.getContent({
                    owner: username,
                    repo: repoName,
                    path: sourceDir
                });

                if (Array.isArray(response.data)) {
                    // 只处理JSON和代码片段文件
                    const jsonFiles = response.data.filter(item =>
                        item.type === 'file' &&
                        (item.name.endsWith('.json') || item.name.endsWith('.code-snippets'))
                    );

                    console.log(`在GitHub发现 ${jsonFiles.length} 个代码片段文件`);

                    let downloadedCount = 0;
                    for (const file of jsonFiles) {
                        try {
                            const localPath = path.join(targetDir, file.name);
                            await syncFileFromGitHub(`${sourceDir}/${file.name}`, localPath, username, repoName, forceOverwrite);
                            downloadedCount++;
                        } catch (error) {
                            console.error(`同步代码片段文件失败: ${file.name}`, error);
                        }
                    }

                    console.log(`代码片段同步完成: ${targetDir}, 成功下载 ${downloadedCount}/${jsonFiles.length} 个文件`);
                } else {
                    throw new Error(`期望的是目录，但获取到的是文件: ${sourceDir}`);
                }
                return;
            }

            // 其他目录，只获取第一层文件
            const response = await octokit.repos.getContent({
                owner: username,
                repo: repoName,
                path: sourceDir
            });

            if (Array.isArray(response.data)) {
                // 只处理文件，不处理子目录
                const files = response.data.filter(item => item.type === 'file');
                console.log(`在GitHub发现 ${files.length} 个文件`);

                // 限制文件数量
                const MAX_FILES = 10;
                const filesToSync = files.slice(0, MAX_FILES);

                let downloadedCount = 0;
                for (const item of filesToSync) {
                    try {
                        const localPath = path.join(targetDir, item.name);
                        await syncFileFromGitHub(`${sourceDir}/${item.name}`, localPath, username, repoName, forceOverwrite);
                        downloadedCount++;
                    } catch (error) {
                        console.error(`同步文件失败: ${item.name}`, error);
                    }
                }

                console.log(`目录同步完成: ${targetDir}, 成功下载 ${downloadedCount}/${Math.min(files.length, MAX_FILES)} 个文件`);
            } else {
                throw new Error(`期望的是目录，但获取到的是文件: ${sourceDir}`);
            }
        } catch (error) {
            if ((error as any).status === 404) {
                console.log(`GitHub上不存在目录，跳过: ${sourceDir}`);
            } else {
                console.error(`从GitHub获取目录内容失败: ${sourceDir}`, error);
                throw error;
            }
        }
    } catch (error) {
        console.error(`从GitHub同步目录失败: ${sourceDir} -> ${targetDir}`, error);
        throw error;
    }
}