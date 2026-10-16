# 从源码构建 DSH Launcher

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
