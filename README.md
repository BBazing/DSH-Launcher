# DSH Launcher

仿照 Minecraft 的 PCL2 启动器制作的 DSH 启动器。支持桌面版与网页版启动、插件下载与管理，以及沿用 DSH 本体的 DeepSeek 登录。

这是独立第三方项目，与 DeepSeek、PCL 官方无隶属关系。PCL 界面及图标参考署名龙腾猫跃，第三方许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 给使用者

在 GitHub Releases 下载 `DSHLauncher-v0.3.0-win-x64.exe`，单独发送这一个文件即可，不需要一起发送源码目录。支持 Windows 10/11 x64，使用系统的 .NET Framework 4.7.2 或以上版本。

EXE 内置 Node.js 24.21.0、pnpm 11.7.0 和 WebView2 SDK。第一次打开会自动把程序文件释放到 `%LOCALAPPDATA%\DSHLauncher\apps\`；这不是不落盘运行的 EXE。配置、缓存、日志和下载的 Web 运行时分别存于 `%LOCALAPPDATA%\DSHLauncher\data\`，不会写到 EXE 所在目录。

1. 已安装官方 DSH：启动器会通过安装信息和常见目录查找；没找到时点击“选择 DSH 程序”，或在设置中“浏览”选择 `DeepSeek Harness.exe`。
2. 未安装 DSH：点击“官方下载 DSH”，安装后选择程序。DSH 本体不包含在这个 EXE 中。
3. 使用网页版：先到“下载”安装 DSH 运行时，再在“版本选择”中新建 Web 实例并安装依赖。插件与运行时下载需要联网。
4. 账号与实例沿用自己的 `%USERPROFILE%\.dsh`。发行包中没有制作者的账号、插件、聊天记录或访问令牌。

内置 pnpm 默认只允许官方运行时所需的 `@deepseek-ai/dsh-subprocess-local`、`koffi`、`node-pty` 构建脚本。其他依赖的安装脚本仍会被 pnpm 阻止并在日志中提示；需要额外原生构建的第三方插件应按其说明配置 `allowBuilds`，不保证所有插件都能直接使用。

启动器新建的 Web 实例使用 DSH 的 `patchReload: startup` 模式，修改插件开关或安装扩展后需要重启该实例。已有实例的设置保持不变。

原生窗口需要 WebView2 Runtime。缺少时会提供微软下载入口，并可临时在浏览器中使用。普通关闭只关窗口；需要更新 EXE 或完全退出时，在“更多 → 百宝箱 → 完全退出启动器”操作。运行中的实例或下载任务须先停止。

本版本未进行 Authenticode 代码签名；Windows 可能显示未知发布者。可将文件的 SHA-256 与同一 Release 的 `SHA256SUMS.txt` 比较。哈希用于核对下载完整性，不替代发布者签名。

## 本地构建

在 Windows x64 上，无需安装 Node 或 .NET SDK，构建使用系统 .NET Framework C# 编译器：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build.ps1 -FetchDependencies
```

依赖从 Node.js、npm、NuGet 官方端点按 `dependencies.lock.json` 固定版本下载和校验。产物在 `dist/`：EXE、SHA-256、负载文件清单和版本信息。构建源文件采用白名单，不读取制作者的用户目录、账号、配置和缓存。

已准备好本机 vendor 和 DLL 时，可省略 `-FetchDependencies`。这些二进制依赖不提交 Git。

```powershell
.\vendor\node\node.exe tests/test-release.mjs
.\vendor\node\node.exe tests/test-live.mjs
& .\dist\DSHLauncher-v0.3.0-win-x64.exe --data-dir "$PWD\build\smoke-profile" --smoke-test --report "$PWD\build\smoke-report.json"
```

`--smoke-test` 使用独立临时 DSH 环境，验证内置 Node / pnpm、HTTP 后台和实际原生窗口后退出，不登录或启动真实 DSH。`--extract-only` 仅验证并释放负载。

`tests/test-live.mjs` 在独立环境实际下载 DSH 0.1.5-rc.2 和 dsh-pet@0.3.7，再验证 Web 启动和插件卸载，需要网络。

## 发布到 GitHub

推荐解压 `dist/DSHLauncher-v0.3.0-source.zip`，将解压后的内容上传到仓库。源码包已排除 vendor、DLL、build、dist 及测试数据。使用 Git 提交本目录时，`.gitignore` 也会排除这些文件；GitHub 网页拖放上传不会自动遵守 `.gitignore`，不要直接拖入整个开发目录。

推送与 `app/package.json` 一致的版本标签，例如 `v0.3.0`，GitHub Actions 会构建并检查产物，然后创建 **草稿 Release**，附上单 EXE 和校验信息。检查草稿后再发布。手动运行工作流只上传构建产物，不创建 Release。

本地上传现成产物时，选择 `dist/DSHLauncher-v0.3.0-win-x64.exe`，建议一起上传 `SHA256SUMS.txt`、`payload-manifest.json` 和 `release-info.json`；使用者只需下载 EXE。
