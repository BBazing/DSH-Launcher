# DSH Launcher

仿照 Minecraft 的 PCL2 启动器制作的 DSH 启动器，用熟悉的界面启动 DeepSeek Harness（DSH）、切换实例和管理插件。

**[下载 Windows 版](https://github.com/BBazing/DSH-Launcher/releases/latest) · [DeepSeek 官网](https://www.deepseek.com/) · [官方下载 DSH](https://www.deepseek.com/download/)**

## 可以做什么

- 启动 DSH 桌面版或网页版，集中管理不同实例。
- 搜索、下载、安装插件，管理插件的启用、停用和卸载。
- 沿用 DSH 本体的 DeepSeek 账号登录。
- 使用参考 PCL2 的启动、下载、设置和插件管理界面。

## 下载与使用

适用于 **Windows 10 / 11，64 位（x64）**。

到[下载页](https://github.com/BBazing/DSH-Launcher/releases/latest)下载 **`DSHLauncher-v0.3.0-win-x64.exe`**，打开即可开始使用。日常使用只需要这一个 EXE，不必下载源码，也不用另外安装 Node.js 或 pnpm。

1. **启动桌面版**：已安装 DSH 时，启动器会尝试自动查找；没有找到就点击“选择 DSH 程序”，选择 `DeepSeek Harness.exe`。尚未安装时，可点击“官方下载 DSH”。
2. **使用网页版**：先在“下载”中安装 DSH 运行时，再在“版本选择”中新建 Web 实例、安装依赖后启动。
3. **登录账号**：沿用 DSH 本体的 DeepSeek 登录方式，使用自己的账号。
4. **管理插件**：在下载页搜索并安装插件，在实例的插件管理页调整开关或卸载。修改后重启对应实例，使更改生效。

DSH 本体不包含在启动器中。下载运行时、依赖和插件时需要联网；部分插件还需要额外配置，具体以插件说明为准。

## 常见问题

**第一次打开需要准备什么？**

启动器会自动释放所需文件到本机用户目录。原生窗口需要 WebView2 Runtime，缺少时按提示安装，也可以先在浏览器中使用。系统需具备 .NET Framework 4.7.2 或以上版本。

**Windows 提示未知发布者或拦截启动？**

当前 EXE 尚未进行代码签名。请从本仓库的下载页获取文件；需要核对下载完整性时，可参考同页的 `SHA256SUMS.txt`。

**配置和账号保存在哪里？**

启动器数据保存在 `%LOCALAPPDATA%\DSHLauncher\`，DSH 账号与实例沿用自己的 `%USERPROFILE%\.dsh`。

**如何完全退出或更换 EXE？**

先停止运行中的实例和下载任务，再点击“更多 → 百宝箱 → 完全退出启动器”。普通关闭只关闭窗口；更新时请完全退出后再更换 EXE。

## 鸣谢与说明

界面和图标参考 [Plain Craft Launcher 2（PCL2）](https://github.com/Meloong-Git/PCL)，感谢龙腾猫跃及相关贡献者。感谢 [DeepSeek](https://www.deepseek.com/) 提供 DSH。

本项目是独立第三方启动器，与 DeepSeek、PCL 官方无隶属关系。第三方许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，源码构建方法见 [BUILDING.md](BUILDING.md)。
