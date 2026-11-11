#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 Dojo Five
# SPDX-License-Identifier: Apache-2.0
"""Write <site>/manifest.json listing every firmware file with its SHA-256."""

import argparse
import hashlib
import json
import pathlib

FLM = {
    "pic32ck_sg01_cnano": ["PIC32CK_SG_BFM.FLM", "PIC32CK_SG_PFM_2048.FLM"],
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("site", type=pathlib.Path)
    parser.add_argument("--release", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--repo", default="", help="GitHub repository URL, for README links")
    args = parser.parse_args()

    boards = {}
    for board_dir in sorted((args.site / "firmware").iterdir()):
        if not board_dir.is_dir() or board_dir.name == "flm":
            continue
        files = {}
        for f in sorted(board_dir.iterdir()):
            files[f.name] = {
                "path": f.relative_to(args.site).as_posix(),
                "size": f.stat().st_size,
                "sha256": hashlib.sha256(f.read_bytes()).hexdigest(),
            }
        flm = []
        for name in FLM.get(board_dir.name, []):
            f = args.site / "firmware" / "flm" / name
            files[name] = {
                "path": f.relative_to(args.site).as_posix(),
                "size": f.stat().st_size,
                "sha256": hashlib.sha256(f.read_bytes()).hexdigest(),
            }
            flm.append(name)
        boards[board_dir.name] = {"files": files, "flm": flm}

    manifest = {"release": args.release, "commit": args.commit, "repo": args.repo, "boards": boards}
    (args.site / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
