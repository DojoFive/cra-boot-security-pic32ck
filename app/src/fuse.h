/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Dojo Five
 * SPDX-License-Identifier: Apache-2.0
 */

#ifndef CRA_BOOT_DEMO_FUSE_H_
#define CRA_BOOT_DEMO_FUSE_H_

#include <stdbool.h>

/** MCUmgr group of the simulated debug-lock fuse. */
#define FUSE_MGMT_GROUP 64U

/** Command 0: read returns {"locked": bool}, write sets the fuse. */
#define FUSE_MGMT_CMD_STATE 0U

/** Command 1, CONFIG_DEMO_FACTORY_UNLOCK only: write clears the fuse and speeds up the blink. */
#define FUSE_MGMT_CMD_FACTORY_UNLOCK 1U

/** Blink period the leftover factory command switches to, in milliseconds. */
#define FUSE_FACTORY_BLINK_MS 250

/** Current blink period in milliseconds, owned by main.c. */
extern int demo_blink_ms;

/**
 * @brief Report whether the simulated fuse is set.
 *
 * @retval true The marker is present in the storage partition.
 * @retval false The marker is absent or the partition cannot be read.
 */
bool fuse_is_locked(void);

/**
 * @brief Set the simulated fuse. Only a chip erase clears it.
 *
 * @retval 0 Fuse set or already set.
 * @retval -errno Flash access failed.
 */
int fuse_lock(void);

#endif /* CRA_BOOT_DEMO_FUSE_H_ */
