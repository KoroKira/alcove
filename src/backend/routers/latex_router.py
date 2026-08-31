import base64
import os
import subprocess
import tempfile

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from dependencies import UserSession, require_auth

latex_router = APIRouter(prefix="/api/latex")


class LatexCompileRequest(BaseModel):
    source: str


@latex_router.post("/compile")
async def compile_latex(
    req: LatexCompileRequest,
    _: UserSession = Depends(require_auth),
):
    """Compile a LaTeX document with pdflatex and return a base64-encoded PDF."""
    if len(req.source) > 200_000:
        raise HTTPException(413, "Document LaTeX trop volumineux")
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            src = os.path.join(tmpdir, "doc.tex")
            with open(src, "w", encoding="utf-8") as f:
                f.write(req.source)

            result = subprocess.run(
                [
                    "pdflatex",
                    "-no-shell-escape",
                    "-interaction=nonstopmode",
                    "-halt-on-error",
                    "-output-directory",
                    tmpdir,
                    src,
                ],
                capture_output=True,
                text=True,
                timeout=30,
                cwd=tmpdir,
            )

            pdf_path = os.path.join(tmpdir, "doc.pdf")
            if os.path.exists(pdf_path):
                with open(pdf_path, "rb") as f:
                    pdf_b64 = base64.b64encode(f.read()).decode()
                return {"success": True, "pdf": pdf_b64, "log": result.stdout[-3000:]}
            else:
                log = (result.stdout + "\n" + result.stderr)[-4000:]
                return JSONResponse(
                    status_code=422,
                    content={"success": False, "pdf": None, "log": log},
                )

    except FileNotFoundError:
        return JSONResponse(
            status_code=503,
            content={
                "success": False,
                "pdf": None,
                "log": (
                    "pdflatex introuvable.\n"
                    "Installez MacTeX : brew install --cask mactex\n"
                    "ou TeX Live : sudo apt-get install texlive-full"
                ),
            },
        )
    except subprocess.TimeoutExpired:
        return JSONResponse(
            status_code=408,
            content={"success": False, "pdf": None, "log": "Timeout de compilation (30 s)."},
        )
