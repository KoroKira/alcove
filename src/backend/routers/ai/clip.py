"""Web clipper: fetch an URL and turn its main content into Markdown.

Stdlib-only HTML → Markdown extractor (no readability/lxml dependency)."""
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from dependencies import UserSession, require_auth
from services.public_http import get_public_url


router = APIRouter()


class ClipRequest(BaseModel):
    url: str


class _MarkdownExtractor:
    """Minimal readability: walks the HTML and emits Markdown for content tags,
    skipping chrome (nav/header/footer/aside/script/form...). Stdlib only."""

    SKIP = {"script", "style", "nav", "footer", "header", "aside", "form",
            "iframe", "noscript", "svg", "button", "select"}
    BLOCK = {"h1": "# ", "h2": "## ", "h3": "### ", "h4": "#### ",
             "h5": "##### ", "h6": "###### ", "li": "- ", "blockquote": "> "}

    def __init__(self):
        from html.parser import HTMLParser

        extractor = self

        class Parser(HTMLParser):
            def __init__(self):
                super().__init__(convert_charrefs=True)
                self.skip_depth = 0
                self.pre_depth = 0
                self.href: Optional[str] = None
                self.out: list[str] = []
                self.buf: list[str] = []
                self.block_prefix = ""
                self.title = ""
                self.in_title = False

            def flush(self):
                text = "".join(self.buf).strip()
                self.buf = []
                if text:
                    self.out.append(f"{self.block_prefix}{text}")
                self.block_prefix = ""

            def handle_starttag(self, tag, attrs):
                if tag in extractor.SKIP:
                    self.skip_depth += 1
                    return
                if self.skip_depth:
                    return
                if tag == "title":
                    self.in_title = True
                elif tag == "pre":
                    self.flush()
                    self.pre_depth += 1
                    self.out.append("```")
                elif tag in extractor.BLOCK:
                    self.flush()
                    self.block_prefix = extractor.BLOCK[tag]
                elif tag in ("p", "div", "section", "article", "tr", "br"):
                    self.flush()
                elif tag == "a":
                    self.href = dict(attrs).get("href")
                    if self.href and not self.href.startswith("http"):
                        self.href = None
                    if self.href:
                        self.buf.append("[")
                elif tag in ("strong", "b"):
                    self.buf.append("**")
                elif tag in ("em", "i"):
                    self.buf.append("*")
                elif tag == "code" and not self.pre_depth:
                    self.buf.append("`")

            def handle_endtag(self, tag):
                if tag in extractor.SKIP:
                    self.skip_depth = max(0, self.skip_depth - 1)
                    return
                if self.skip_depth:
                    return
                if tag == "title":
                    self.in_title = False
                elif tag == "pre":
                    self.flush()
                    self.pre_depth = max(0, self.pre_depth - 1)
                    self.out.append("```")
                elif tag in extractor.BLOCK or tag in ("p", "div", "section", "article", "tr"):
                    self.flush()
                elif tag == "a" and self.href:
                    self.buf.append(f"]({self.href})")
                    self.href = None
                elif tag in ("strong", "b"):
                    self.buf.append("**")
                elif tag in ("em", "i"):
                    self.buf.append("*")
                elif tag == "code" and not self.pre_depth:
                    self.buf.append("`")

            def handle_data(self, data):
                if self.skip_depth:
                    return
                if self.in_title and not self.title:
                    self.title = data.strip()
                    return
                if self.pre_depth:
                    self.out.append(data.rstrip("\n"))
                else:
                    self.buf.append(data)

        self.parser = Parser()

    def extract(self, html: str) -> tuple[str, str]:
        self.parser.feed(html)
        self.parser.flush()
        lines = [l for l in self.parser.out if l.strip()]
        return self.parser.title, "\n\n".join(lines)


@router.post("/clip")
async def clip_url(body: ClipRequest, _: UserSession = Depends(require_auth)):
    """Fetch a web page and return its main content as Markdown."""
    url = body.url.strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="URL invalide (http/https uniquement)")
    # GitHub blob pages: fetch the raw file instead of the HTML viewer
    gh = re.match(r"https://github\.com/([^/]+/[^/]+)/blob/(.+)", url)
    if gh:
        url = f"https://raw.githubusercontent.com/{gh.group(1)}/{gh.group(2)}"
    try:
        resp = await get_public_url(url, headers={"User-Agent": "Mozilla/5.0 (alcove clipper)"})
        resp.raise_for_status()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Impossible de récupérer la page : {e}")

    content_type = resp.headers.get("content-type", "")
    if "html" not in content_type:
        # Raw text/markdown file — return as-is
        return {"title": url.rsplit("/", 1)[-1], "markdown": resp.text[:100_000], "url": body.url}

    title, markdown = _MarkdownExtractor().extract(resp.text[:1_500_000])
    if len(markdown) > 100_000:
        markdown = markdown[:100_000] + "\n\n*[contenu tronqué]*"
    return {"title": title or url, "markdown": markdown, "url": body.url}
