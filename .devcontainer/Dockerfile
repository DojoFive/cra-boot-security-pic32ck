# SPDX-FileCopyrightText: Copyright (c) 2026 Dojo Five
# SPDX-License-Identifier: Apache-2.0

FROM ubuntu:24.04

# The default "ubuntu" user takes uid 1000; common-utils recreates the host user.
RUN userdel -r ubuntu 2>/dev/null || true

RUN apt-get update && apt-get install -y --no-install-recommends \
	git cmake ninja-build gperf ccache device-tree-compiler wget xz-utils file make \
	gcc g++ python3 python3-venv python3-dev python3-pip libmagic1 ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

# Parent of the bind-mounted checkout; west puts zephyr, the modules and .west here.
RUN mkdir -p /west-workspace && chmod 1777 /west-workspace
