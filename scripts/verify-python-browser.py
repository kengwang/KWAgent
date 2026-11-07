import functools
import json
import pathlib
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import sync_playwright

mode = sys.argv[1]
workspace = pathlib.Path.cwd()
fixtures = pathlib.Path(__file__).parent / 'fixtures'
handler = functools.partial(SimpleHTTPRequestHandler, directory=str(fixtures))
server = ThreadingHTTPServer(('127.0.0.1', 0 if mode == 'image' else 8765), handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    if mode != 'image':
        import idna
        assert pathlib.Path(idna.__file__).is_relative_to(pathlib.Path(sys.prefix))
        assert pathlib.Path(sys.prefix) == pathlib.Path('/data/python/.venv')
        assert idna.__version__ == '3.11'
    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(str(workspace / 'browser-profile'), headless=True, accept_downloads=True)
        try:
            page = context.new_page()
            page.goto(f'http://127.0.0.1:{server.server_address[1]}/python-browser.html')
            assert page.title() == 'KWAgent Browser Check'
            if mode == 'resume':
                assert page.evaluate('localStorage.getItem("message")') == '持久环境中的实际浏览器操作'
                assert any(cookie['name'] == 'kwagent' and cookie['value'] == 'browser-check' for cookie in context.cookies())
                assert (workspace / 'page.png').stat().st_size > 0
                assert (workspace / 'download.txt').read_text() == (fixtures / 'download.txt').read_text()
            page.locator('#message').fill('持久环境中的实际浏览器操作')
            page.locator('#submit').click()
            assert page.locator('#result').inner_text() == '持久环境中的实际浏览器操作'
            with page.expect_download() as download:
                page.locator('#download').click()
            download.value.save_as(workspace / 'download.txt')
            assert (workspace / 'download.txt').read_text() == (fixtures / 'download.txt').read_text()
            page.screenshot(path=str(workspace / 'page.png'))
            assert (workspace / 'page.png').stat().st_size > 0
        finally:
            context.close()
    print(json.dumps({'mode': mode, 'actualChromium': True, 'form': True, 'download': True, 'screenshot': True, 'restoredProfile': mode == 'resume'}, ensure_ascii=False))
finally:
    server.shutdown()
    thread.join()
    server.server_close()
