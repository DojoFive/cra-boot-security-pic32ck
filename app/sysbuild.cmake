# SPDX-FileCopyrightText: Copyright (c) 2026 Dojo Five
# SPDX-License-Identifier: Apache-2.0

# Board-specific MCUboot overlay and config: MCUboot selects its own code
# partition and, on some boards, needs fixed sector counts.
set(overlay ${CMAKE_CURRENT_LIST_DIR}/boards/${BOARD}_mcuboot.overlay)
if(EXISTS ${overlay})
	set(mcuboot_EXTRA_DTC_OVERLAY_FILE ${overlay} CACHE INTERNAL "")
endif()

# Setting EXTRA_CONF_FILE replaces sysbuild's automatic pickup of
# sysbuild/mcuboot.conf, so list it explicitly.
set(confs ${CMAKE_CURRENT_LIST_DIR}/sysbuild/mcuboot.conf)
if(SB_CONFIG_DEMO_DOWNGRADE_PREVENTION)
	list(APPEND confs ${CMAKE_CURRENT_LIST_DIR}/sysbuild/mcuboot_downgrade.conf)
endif()
if(EXISTS ${CMAKE_CURRENT_LIST_DIR}/boards/${BOARD}_mcuboot.conf)
	list(APPEND confs ${CMAKE_CURRENT_LIST_DIR}/boards/${BOARD}_mcuboot.conf)
endif()
set(mcuboot_EXTRA_CONF_FILE "${confs}" CACHE INTERNAL "")
