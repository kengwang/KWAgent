# Python 与浏览器

所有角色共用 `/data/python/.venv`，使用 uv 安装的依赖对所有角色生效。脚本、浏览器登录状态 `browser-profile`、截图和下载保存在各自工作目录。共享环境和角色工作目录均持久保存。

```sh
. /data/python/.venv/bin/activate
python --version
uv pip install --python /data/python/.venv/bin/python 包名
python script.py
```

每次 shell 工具调用都有自己的环境，激活需要在同一次调用内完成。也可以直接执行 `/data/python/.venv/bin/python script.py`。将 Python 代码保存为 `.py` 文件，再通过命令执行工具运行；`run_code` 的 `code` 使用 JavaScript，通过工具 SDK 调用执行能力。不需要重新安装 uv、Playwright 或浏览器。基础 Playwright 与浏览器由镜像配套管理，其他 Python 包安装到共享 venv；不要向系统 Python 安装包。

使用 Python Playwright 操作浏览器，例如保存实际打开页面的截图：

```python
from pathlib import Path
from playwright.sync_api import sync_playwright

# target_url 取自当前任务中的实际地址。
output = Path("browser-output")
output.mkdir(exist_ok=True)
with sync_playwright() as playwright:
    context = playwright.chromium.launch_persistent_context(
        "browser-profile", headless=True, accept_downloads=True
    )
    try:
        page = context.pages[0] if context.pages else context.new_page()
        page.goto(target_url, wait_until="domcontentloaded")
        page.screenshot(path=str(output / "page.png"), full_page=True)
        # 保存下载时使用 download.save_as(output / download.suggested_filename)。
    finally:
        context.close()
```

同一个持久 profile 同时交给一个浏览器实例使用。一次性浏览可以使用 `chromium.launch(headless=True)` 和 `browser.new_context()`，不需要保存登录状态。先观察实际页面，再根据当前页面元素操作；内部输出、预期动作和工具结果未知都不能证明页面操作成功。浏览器 profile 含有登录资料，按当前任务妥善使用。
