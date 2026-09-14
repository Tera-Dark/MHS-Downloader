"""Generate offline help/privacy pages from repository Markdown, using only the stdlib."""

from pathlib import Path
import html
import re

ROOT = Path(__file__).resolve().parents[1]


def inline(text):
    escaped = html.escape(text)
    escaped = re.sub(r"`([^`]+)`", r"<code>\1</code>", escaped)
    return re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", escaped)


def render(markdown):
    parts = []
    list_type = None
    for line in markdown.splitlines():
        match = re.match(r"^(\d+\. |\- )(.*)$", line)
        kind = (
            "ol" if match and match.group(1)[0].isdigit() else "ul" if match else None
        )
        if list_type and kind != list_type:
            parts.append(f"</{list_type}>")
            list_type = None
        if kind:
            if not list_type:
                parts.append(f"<{kind}>")
                list_type = kind
            parts.append("<li>" + inline(match.group(2)) + "</li>")
        elif line.startswith("# "):
            parts.append("<h1>" + inline(line[2:]) + "</h1>")
        elif line.startswith("## "):
            parts.append("<h2>" + inline(line[3:]) + "</h2>")
        elif line.strip():
            parts.append("<p>" + inline(line) + "</p>")
    if list_type:
        parts.append(f"</{list_type}>")
    return "\n".join(parts)


CSS = "body{margin:0;background:#f5f3ed;color:#284436;font:15px/1.9 system-ui,sans-serif}main{max-width:850px;margin:auto;padding:30px 24px}h1{font-size:28px}h2{font-size:19px;margin-top:35px}nav{display:flex;gap:18px;border-bottom:1px solid #d6e0cb;padding:16px 0}a{color:#315b43}code{background:#e6eddd;border-radius:4px;padding:2px 6px;font-size:13px;overflow-wrap:anywhere}p,li{overflow-wrap:anywhere}li{margin:9px 0}strong{color:#315b43}"
for source, output, title in [
    ("user-guide.md", "help.html", "使用说明"),
    ("privacy.md", "privacy.html", "隐私说明"),
]:
    body = render((ROOT / "docs" / source).read_text(encoding="utf-8"))
    page = f'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>画页存档 · {title}</title><link rel="icon" href="icon32.png"><style>{CSS}</style></head><body><main><nav><a href="manager.html">返回工作台</a><a href="help.html">使用说明</a><a href="privacy.html">隐私说明</a></nav>{body}</main></body></html>\n'
    (ROOT / "extension" / output).write_text(page, encoding="utf-8")
