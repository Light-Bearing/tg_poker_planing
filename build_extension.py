#!/usr/bin/env python3
"""Build browser-extension.zip from browser-extension/ folder."""

import os
import zipfile


def build_zip(source_dir="browser-extension", output="browser-extension/pp-jira-bridge.zip"):
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, files in os.walk(source_dir):
            for fn in files:
                if fn.endswith(".zip"):
                    continue
                full = os.path.join(root, fn)
                arcname = os.path.relpath(full, source_dir)
                zf.write(full, arcname)
    print(f"Created {output} ({os.path.getsize(output)} bytes)")


if __name__ == "__main__":
    build_zip()
