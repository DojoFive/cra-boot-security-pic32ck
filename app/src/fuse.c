/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Dojo Five
 * SPDX-License-Identifier: Apache-2.0
 *
 * Simulated one-time fuse. A marker at the start of the storage partition
 * stands in for the debug lock a production part gets from its DAL/OTP
 * settings. Firmware can set it but never clear it; the host clears it with a
 * chip erase, as it would on real silicon. The exception is the demo's known
 * hole, CONFIG_DEMO_FACTORY_UNLOCK, left in the v1.x releases.
 */

#include <string.h>
#include <zephyr/kernel.h>
#include <zephyr/drivers/flash.h>
#include <zephyr/storage/flash_map.h>
#include <zephyr/mgmt/mcumgr/mgmt/mgmt.h>
#include <zephyr/mgmt/mcumgr/mgmt/handlers.h>
#include <zephyr/mgmt/mcumgr/smp/smp.h>
#include <zephyr/sys/printk.h>
#include <zcbor_encode.h>

#include "fuse.h"

static const uint8_t fuse_magic[16] = "CRA-DEMO-LOCKED";

bool fuse_is_locked(void)
{
	const struct flash_area *fa;
	uint8_t buf[sizeof(fuse_magic)];
	int err;

	err = flash_area_open(PARTITION_ID(storage_partition), &fa);
	if (err != 0) {
		return false;
	}

	err = flash_area_read(fa, 0, buf, sizeof(buf));
	flash_area_close(fa);

	return (err == 0) && (memcmp(buf, fuse_magic, sizeof(buf)) == 0);
}

int fuse_lock(void)
{
	const struct flash_area *fa;
	const struct flash_parameters *params;
	uint8_t erased[sizeof(fuse_magic)];
	uint8_t buf[sizeof(fuse_magic)];
	int err;

	if (fuse_is_locked()) {
		return 0;
	}

	err = flash_area_open(PARTITION_ID(storage_partition), &fa);
	if (err != 0) {
		return err;
	}

	params = flash_get_parameters(flash_area_get_device(fa));
	memset(erased, params->erase_value, sizeof(erased));

	err = flash_area_read(fa, 0, buf, sizeof(buf));
	if ((err == 0) && (memcmp(buf, erased, sizeof(buf)) != 0)) {
		err = flash_area_erase(fa, 0, fa->fa_size);
	}
	if (err == 0) {
		err = flash_area_write(fa, 0, fuse_magic, sizeof(fuse_magic));
	}

	flash_area_close(fa);
	return err;
}

#ifdef CONFIG_DEMO_FACTORY_UNLOCK
static int fuse_clear(void)
{
	const struct flash_area *fa;
	int err;

	err = flash_area_open(PARTITION_ID(storage_partition), &fa);
	if (err != 0) {
		return err;
	}

	err = flash_area_erase(fa, 0, fa->fa_size);
	flash_area_close(fa);
	return err;
}
#endif

static bool fuse_encode_state(struct smp_streamer *ctxt)
{
	zcbor_state_t *zse = ctxt->writer->zs;

	return zcbor_tstr_put_lit(zse, "locked") && zcbor_bool_put(zse, fuse_is_locked());
}

static int fuse_mgmt_read(struct smp_streamer *ctxt)
{
	return fuse_encode_state(ctxt) ? MGMT_ERR_EOK : MGMT_ERR_EMSGSIZE;
}

static int fuse_mgmt_write(struct smp_streamer *ctxt)
{
	if (fuse_lock() != 0) {
		return MGMT_ERR_EUNKNOWN;
	}

	return fuse_encode_state(ctxt) ? MGMT_ERR_EOK : MGMT_ERR_EMSGSIZE;
}

#ifdef CONFIG_DEMO_FACTORY_UNLOCK
static int fuse_mgmt_factory_unlock(struct smp_streamer *ctxt)
{
	if (fuse_clear() != 0) {
		return MGMT_ERR_EUNKNOWN;
	}

	demo_blink_ms = FUSE_FACTORY_BLINK_MS;
	printk("Got you! v%s factory command: blink %d ms, debug lock cleared\n",
	       CONFIG_MCUBOOT_IMGTOOL_SIGN_VERSION, demo_blink_ms);

	return fuse_encode_state(ctxt) ? MGMT_ERR_EOK : MGMT_ERR_EMSGSIZE;
}
#endif

static const struct mgmt_handler fuse_mgmt_handlers[] = {
	[FUSE_MGMT_CMD_STATE] = {
		.mh_read = fuse_mgmt_read,
		.mh_write = fuse_mgmt_write,
	},
#ifdef CONFIG_DEMO_FACTORY_UNLOCK
	[FUSE_MGMT_CMD_FACTORY_UNLOCK] = {
		.mh_write = fuse_mgmt_factory_unlock,
	},
#endif
};

static struct mgmt_group fuse_mgmt_group = {
	.mg_handlers = fuse_mgmt_handlers,
	.mg_handlers_count = ARRAY_SIZE(fuse_mgmt_handlers),
	.mg_group_id = FUSE_MGMT_GROUP,
};

static void fuse_mgmt_init(void)
{
	mgmt_register_group(&fuse_mgmt_group);
}

MCUMGR_HANDLER_DEFINE(fuse_mgmt, fuse_mgmt_init);
