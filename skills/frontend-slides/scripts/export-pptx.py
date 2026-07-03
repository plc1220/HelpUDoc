#!/usr/bin/env python3
"""Export an HTML slide deck to a widescreen PPTX.

The v1 export is fidelity-first: each rendered HTML slide is captured as a
1920x1080 PNG and placed full-bleed on a PowerPoint slide. The resulting deck
opens everywhere PowerPoint files are supported, but slide content is flattened
into images rather than converted into editable Office shapes.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from textwrap import dedent

from pptx import Presentation
from pptx.util import Inches


DEFAULT_WIDTH = 1920
DEFAULT_HEIGHT = 1080


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export an HTML presentation to a screenshot-backed PPTX."
    )
    parser.add_argument("html", help="Path to the HTML presentation.")
    parser.add_argument(
        "output",
        nargs="?",
        help="Output .pptx path. Defaults to the HTML filename with .pptx.",
    )
    parser.add_argument(
        "--screenshots-dir",
        help=(
            "Use existing PNG screenshots instead of launching a browser. "
            "Useful for tests or custom capture pipelines."
        ),
    )
    parser.add_argument(
        "--keep-screenshots",
        action="store_true",
        help="Keep generated screenshots next to the output PPTX.",
    )
    parser.add_argument(
        "--width",
        type=int,
        default=DEFAULT_WIDTH,
        help=f"Capture width in pixels. Default: {DEFAULT_WIDTH}.",
    )
    parser.add_argument(
        "--height",
        type=int,
        default=DEFAULT_HEIGHT,
        help=f"Capture height in pixels. Default: {DEFAULT_HEIGHT}.",
    )
    return parser.parse_args()


def natural_pngs(directory: Path) -> list[Path]:
    def sort_key(path: Path) -> tuple[int, str]:
        digits = "".join(ch for ch in path.stem if ch.isdigit())
        return (int(digits) if digits else 0, path.name)

    return sorted(directory.glob("*.png"), key=sort_key)


def run(command: list[str], *, cwd: Path | None = None) -> None:
    try:
        subprocess.run(command, cwd=cwd, check=True)
    except FileNotFoundError as exc:
        raise SystemExit(f"Missing executable: {command[0]}") from exc
    except subprocess.CalledProcessError as exc:
        raise SystemExit(f"Command failed ({exc.returncode}): {' '.join(command)}") from exc


def node_capture_script() -> str:
    return dedent(
        r"""
        import { chromium } from 'playwright';
        import { createServer } from 'http';
        import { readFileSync, existsSync, mkdirSync } from 'fs';
        import { join, extname, resolve } from 'path';

        const serveDir = process.argv[2];
        const htmlFile = process.argv[3];
        const outDir = process.argv[4];
        const width = Number(process.argv[5] || 1920);
        const height = Number(process.argv[6] || 1080);

        const mimeTypes = {
          '.html': 'text/html',
          '.css': 'text/css',
          '.js': 'application/javascript',
          '.json': 'application/json',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.svg': 'image/svg+xml',
          '.webp': 'image/webp',
          '.woff': 'font/woff',
          '.woff2': 'font/woff2',
          '.ttf': 'font/ttf',
        };

        mkdirSync(outDir, { recursive: true });

        const server = createServer((req, res) => {
          const decoded = decodeURIComponent(req.url || '/');
          const relative = decoded === '/' ? htmlFile : decoded.replace(/^\/+/, '');
          const filePath = resolve(join(serveDir, relative));
          if (!filePath.startsWith(resolve(serveDir))) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
          }
          try {
            const content = readFileSync(filePath);
            const ext = extname(filePath).toLowerCase();
            res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
            res.end(content);
          } catch {
            res.writeHead(404);
            res.end('Not found');
          }
        });

        await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
        const port = server.address().port;

        const browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
        await page.goto(`http://127.0.0.1:${port}/${encodeURIComponent(htmlFile)}`, {
          waitUntil: 'networkidle',
        });

        await page.evaluate(() => document.fonts && document.fonts.ready);
        await page.waitForTimeout(300);

        const slideCount = await page.evaluate(() => document.querySelectorAll('.slide').length);
        if (!slideCount) {
          await browser.close();
          server.close();
          throw new Error('No .slide elements found in the presentation.');
        }

        for (let index = 0; index < slideCount; index += 1) {
          await page.evaluate((activeIndex) => {
            const deckStage = document.querySelector('deck-stage');
            if (deckStage) deckStage.setAttribute('noscale', '');

            const stage = document.querySelector('#deckStage, .deck-stage');
            if (stage) {
              stage.style.transform = 'none';
              stage.style.left = '0';
              stage.style.top = '0';
            }

            const slides = Array.from(document.querySelectorAll('.slide'));
            slides.forEach((slide, slideIndex) => {
              const active = slideIndex === activeIndex;
              slide.classList.toggle('active', active);
              slide.classList.toggle('visible', active);
              slide.style.visibility = active ? 'visible' : 'hidden';
              slide.style.opacity = active ? '1' : '0';
              slide.style.pointerEvents = active ? 'auto' : 'none';
              slide.style.zIndex = active ? '1' : '0';
            });

            window.dispatchEvent(new CustomEvent('slidechange', { detail: { index: activeIndex } }));
          }, index);
          await page.waitForTimeout(150);
          const path = join(outDir, `slide-${String(index + 1).padStart(3, '0')}.png`);
          await page.screenshot({ path, fullPage: false });
        }

        await browser.close();
        server.close();
        console.log(JSON.stringify({ slideCount, outDir }));
        """
    ).strip()


def capture_screenshots(html_path: Path, output_dir: Path, width: int, height: int) -> list[Path]:
    if not shutil.which("npm"):
        raise SystemExit("Node.js/npm is required for browser capture.")

    with tempfile.TemporaryDirectory(prefix="frontend-slides-pptx-node-") as tmp:
        tmp_path = Path(tmp)
        (tmp_path / "package.json").write_text(
            '{"name":"frontend-slides-pptx-export","private":true,"type":"module"}\n',
            encoding="utf-8",
        )
        script_path = tmp_path / "capture-slides.mjs"
        script_path.write_text(node_capture_script(), encoding="utf-8")

        run(["npm", "install", "--silent", "playwright"], cwd=tmp_path)
        run(["npx", "playwright", "install", "chromium"], cwd=tmp_path)
        run(
            [
                "node",
                str(script_path),
                str(html_path.parent),
                html_path.name,
                str(output_dir),
                str(width),
                str(height),
            ],
            cwd=tmp_path,
        )

    screenshots = natural_pngs(output_dir)
    if not screenshots:
        raise SystemExit(f"No screenshots were generated in {output_dir}")
    return screenshots


def build_pptx(screenshots: list[Path], output_path: Path) -> None:
    prs = Presentation()
    prs.slide_width = Inches(13.333333)
    prs.slide_height = Inches(7.5)
    blank_layout = prs.slide_layouts[6]

    for screenshot in screenshots:
        slide = prs.slides.add_slide(blank_layout)
        slide.shapes.add_picture(
            str(screenshot),
            0,
            0,
            width=prs.slide_width,
            height=prs.slide_height,
        )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    prs.save(output_path)


def main() -> int:
    args = parse_args()
    html_path = Path(args.html).expanduser().resolve()
    if not html_path.exists():
        print(f"HTML file not found: {html_path}", file=sys.stderr)
        return 1

    output_path = (
        Path(args.output).expanduser().resolve()
        if args.output
        else html_path.with_suffix(".pptx")
    )

    if args.screenshots_dir:
        screenshots_dir = Path(args.screenshots_dir).expanduser().resolve()
        screenshots = natural_pngs(screenshots_dir)
        if not screenshots:
            print(f"No PNG screenshots found in {screenshots_dir}", file=sys.stderr)
            return 1
        build_pptx(screenshots, output_path)
        print(f"Exported {len(screenshots)} slides to {output_path}")
        return 0

    with tempfile.TemporaryDirectory(prefix="frontend-slides-pptx-") as tmp:
        screenshots_dir = Path(tmp) / "screenshots"
        screenshots_dir.mkdir(parents=True, exist_ok=True)
        screenshots = capture_screenshots(html_path, screenshots_dir, args.width, args.height)
        build_pptx(screenshots, output_path)

        if args.keep_screenshots:
            kept_dir = output_path.with_suffix("")
            kept_dir = kept_dir.parent / f"{kept_dir.name}-screenshots"
            if kept_dir.exists():
                shutil.rmtree(kept_dir)
            shutil.copytree(screenshots_dir, kept_dir)
            print(f"Saved screenshots to {kept_dir}")

    print(f"Exported {len(screenshots)} slides to {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
