"""Shared test fixtures for office-service tests."""

import os
import sys
from pathlib import Path

import pytest

# Add the office-service root to path so imports work
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ.setdefault("OFFICE_SERVICE_WORKSPACE_ROOT", "/tmp/office-test-workspaces")
os.environ.setdefault("OFFICE_SERVICE_OFFICECLI_BIN", "/tmp/fake-officecli")


@pytest.fixture
def workspace_root(tmp_path):
    """Provide a temporary workspace root directory."""
    os.environ["OFFICE_SERVICE_WORKSPACE_ROOT"] = str(tmp_path)
    yield tmp_path
    os.environ.pop("OFFICE_SERVICE_WORKSPACE_ROOT", None)


@pytest.fixture
def workspace_dir(workspace_root):
    """Create a workspace directory."""
    ws_dir = workspace_root / "test-workspace"
    ws_dir.mkdir()
    return ws_dir


@pytest.fixture
def sample_docx(workspace_dir):
    """Create a minimal valid .docx file in the workspace."""
    import zipfile

    docx_path = workspace_dir / "sample.docx"
    with zipfile.ZipFile(docx_path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/word/document.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
            "</Types>",
        )
        zf.writestr(
            "_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
        )
        zf.writestr(
            "word/document.xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            "<w:body><w:p><w:r><w:t>Hello World</w:t></w:r></w:p></w:body></w:document>",
        )
    return docx_path


@pytest.fixture
def fake_officecli(tmp_path):
    """Create a fake officecli binary that validates exact argv and emits real JSON envelope.

    Validates:
    - batch: officecli batch <file> --input <manifest> --json [--best-effort]
    - create: officecli create <file> --force --locale en-US --json
    - validate: officecli validate <file> --json
    - --version: outputs version string
    """
    bin_path = tmp_path / "officecli"
    bin_path.write_text(
        '''#!/bin/bash
set -eu

if [ "$1" = "--version" ]; then
  echo "1.0.143"
  exit 0
fi

if [ "$1" = "create" ]; then
  FILE="$2"
  if [ "$3" != "--force" ] || [ "$4" != "--locale" ] || [ "$5" != "en-US" ] || [ "$6" != "--json" ]; then
    echo '{"success":false,"data":"Invalid create args: expected --force --locale en-US --json"}' >&2
    exit 1
  fi
  touch "$FILE"
  echo '{"success":true,"data":"Created: '"$FILE"'","message":"Created: '"$FILE"'"}'
  exit 0
fi

if [ "$1" = "validate" ]; then
  FILE="$2"
  if [ "$3" != "--json" ]; then
    echo '{"success":false,"data":"Expected --json"}' >&2
    exit 1
  fi
  echo '{"success":true,"data":{"count":0,"errors":[]}}'
  exit 0
fi

if [ "$1" = "batch" ]; then
  FILE="$2"
  if [ "$3" != "--input" ]; then
    echo '{"success":false,"data":"Expected --input as third arg, got '"$3"'"}' >&2
    exit 1
  fi
  MANIFEST="$4"
  if [ "$5" != "--json" ]; then
    echo '{"success":false,"data":"Expected --json as fifth arg, got '"$5"'"}' >&2
    exit 1
  fi

  # Build proper results via python
  python3 -c "
import json, sys
ops = json.load(open('$MANIFEST'))
results = []
for i, op in enumerate(ops):
    cmd = op.get('command', op.get('op', 'unknown'))
    results.append({'index': i, 'success': True, 'output': f'Executed {cmd} at index {i}'})
envelope = {
    'success': True,
    'data': {
        'results': results,
        'summary': {
            'total': len(ops),
            'executed': len(ops),
            'succeeded': len(ops),
            'failed': 0,
            'skipped': 0
        }
    }
}
print(json.dumps(envelope))
"
  exit 0
fi

echo '{"success":false,"data":"Unknown command: '"$1"'"}'
exit 1
''')
    bin_path.chmod(0o755)
    os.environ["OFFICE_SERVICE_OFFICECLI_BIN"] = str(bin_path)
    yield bin_path
    os.environ.pop("OFFICE_SERVICE_OFFICECLI_BIN", None)
